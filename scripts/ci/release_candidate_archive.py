#!/usr/bin/env python3

import argparse
import ctypes
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
import zlib


VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
POLICY_PATH = Path(__file__).with_name("release-candidate-policy.json")
with POLICY_PATH.open(encoding="utf-8") as policy_file:
    CANDIDATE_POLICY = json.load(policy_file)
MAX_COMPRESSION_RATIO = CANDIDATE_POLICY.get("maxCompressionRatio")
MAX_CENTRAL_DIRECTORY_BYTES = CANDIDATE_POLICY.get("centralDirectoryMaxBytes")
MANIFEST_MAX_BYTES = CANDIDATE_POLICY.get("manifestMaxBytes")
PRODUCT_POLICIES = CANDIDATE_POLICY.get("products")
EOCD_SIGNATURE = b"PK\x05\x06"
EOCD_STRUCT = struct.Struct("<4s4H2IH")
ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
ZIP64_LOCATOR_BYTES = 20
ZIP_COMMENT_MAX_BYTES = 0xFFFF


class CandidateArchiveError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise CandidateArchiveError(message)


def product_policy(product, version):
    require(CANDIDATE_POLICY.get("schema") == 1, "Unsupported release candidate policy schema")
    require(isinstance(MAX_COMPRESSION_RATIO, int) and MAX_COMPRESSION_RATIO > 0, "Invalid compression ratio policy")
    require(
        type(MAX_CENTRAL_DIRECTORY_BYTES) is int and MAX_CENTRAL_DIRECTORY_BYTES > 0,
        "Invalid central directory size policy",
    )
    require(isinstance(MANIFEST_MAX_BYTES, int) and MANIFEST_MAX_BYTES > 0, "Invalid manifest size policy")
    require(isinstance(PRODUCT_POLICIES, dict) and product in PRODUCT_POLICIES, f"Unsupported release product: {product}")
    require(VERSION_PATTERN.fullmatch(version) is not None, f"Invalid release version: {version}")
    policy = PRODUCT_POLICIES[product]
    require(isinstance(policy, dict), f"Invalid release candidate policy for {product}")
    require(
        isinstance(policy.get("archiveMaxBytes"), int) and policy["archiveMaxBytes"] > 0,
        f"Invalid archive size policy for {product}",
    )
    require(isinstance(policy.get("payloads"), list) and policy["payloads"], f"Invalid payload policy for {product}")
    require(
        type(policy.get("expectedEntries")) is int and policy["expectedEntries"] > 0,
        f"Invalid expected entry count policy for {product}",
    )
    return policy


def render_version_template(template, version):
    require(isinstance(template, str) and template.count("{version}") == 1, f"Invalid path template: {template}")
    rendered = template.replace("{version}", version)
    require(rendered not in ("", ".", "..") and "/" not in rendered and "\\" not in rendered, f"Invalid path: {rendered}")
    return rendered


def expected_entry_limits(product, version):
    policy = product_policy(product, version)
    limits = {"release-candidate.json": MANIFEST_MAX_BYTES}
    for payload in policy["payloads"]:
        require(isinstance(payload, dict) and set(payload) == {"path", "maxBytes"}, "Invalid payload policy entry")
        require(isinstance(payload["maxBytes"], int) and payload["maxBytes"] > 0, "Invalid payload size policy")
        name = render_version_template(payload["path"], version)
        require(name not in limits, f"Duplicate payload policy path: {name}")
        limits[name] = payload["maxBytes"]
    require(
        len(limits) == policy["expectedEntries"],
        f"Expected entry count policy does not match payload policy for {product}",
    )
    return limits


def validate_zip_eocd(source, archive_size, expected_entries):
    tail_size = min(archive_size, EOCD_STRUCT.size + ZIP_COMMENT_MAX_BYTES)
    tail_offset = archive_size - tail_size
    source.seek(tail_offset, os.SEEK_SET)
    tail = source.read(tail_size)
    require(len(tail) == tail_size, "Candidate ZIP ended while reading its EOCD record")

    candidates = []
    search_end = len(tail)
    while True:
        candidate = tail.rfind(EOCD_SIGNATURE, 0, search_end)
        if candidate < 0:
            break
        if candidate + EOCD_STRUCT.size <= len(tail):
            fields = EOCD_STRUCT.unpack_from(tail, candidate)
            comment_length = fields[-1]
            if candidate + EOCD_STRUCT.size + comment_length == len(tail):
                candidates.append((candidate, fields))
        search_end = candidate

    require(len(candidates) == 1, "Candidate ZIP has no unambiguous EOCD record")
    candidate, fields = candidates[0]
    (
        _,
        disk_number,
        central_directory_disk,
        entries_on_disk,
        entries_total,
        central_directory_size,
        central_directory_offset,
        _,
    ) = fields
    eocd_offset = tail_offset + candidate

    require(
        disk_number != 0xFFFF
        and central_directory_disk != 0xFFFF
        and entries_on_disk != 0xFFFF
        and entries_total != 0xFFFF
        and central_directory_size != 0xFFFFFFFF
        and central_directory_offset != 0xFFFFFFFF,
        "ZIP64 candidate ZIP is not allowed",
    )
    if eocd_offset >= ZIP64_LOCATOR_BYTES:
        source.seek(eocd_offset - ZIP64_LOCATOR_BYTES, os.SEEK_SET)
        require(
            source.read(len(ZIP64_LOCATOR_SIGNATURE)) != ZIP64_LOCATOR_SIGNATURE,
            "ZIP64 candidate ZIP is not allowed",
        )
    require(
        disk_number == 0 and central_directory_disk == 0,
        "Multi-disk candidate ZIP is not allowed",
    )
    require(
        entries_on_disk == entries_total == expected_entries,
        "Candidate ZIP layout mismatch: EOCD entry count does not match product policy",
    )
    require(
        0 < central_directory_size <= MAX_CENTRAL_DIRECTORY_BYTES,
        "Candidate ZIP central directory exceeds its metadata limit",
    )
    require(
        central_directory_offset + central_directory_size <= eocd_offset,
        "Candidate ZIP central directory is outside archive bounds",
    )


@contextmanager
def open_candidate_archive(archive_path, product, version):
    archive_path = Path(archive_path)
    policy = product_policy(product, version)
    expected_entries = len(expected_entry_limits(product, version))
    try:
        open_flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(archive_path, open_flags)
        try:
            source = os.fdopen(descriptor, "rb")
        except BaseException:
            os.close(descriptor)
            raise
        with source:
            details = os.fstat(source.fileno())
            require(stat.S_ISREG(details.st_mode), "Candidate ZIP must be a regular file")
            require(details.st_size > 0, "Candidate ZIP is empty")
            require(
                details.st_size <= policy["archiveMaxBytes"],
                f"Candidate ZIP exceeds the {product} archive size limit",
            )
            validate_zip_eocd(source, details.st_size, expected_entries)
            source.seek(0, os.SEEK_SET)
            with zipfile.ZipFile(source, "r", allowZip64=False) as archive:
                yield archive
    except CandidateArchiveError:
        raise
    except (
        OSError,
        RuntimeError,
        UnicodeError,
        struct.error,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        zlib.error,
    ) as error:
        raise CandidateArchiveError(f"Invalid candidate ZIP: {error}") from error


def validate_entry(info, max_bytes):
    require(not info.is_dir(), f"Candidate ZIP entry must be a regular file: {info.filename}")
    require(info.volume == 0, "Multi-disk candidate ZIP is not allowed")
    require((info.flag_bits & 0x1) == 0, f"Encrypted candidate ZIP entry is not allowed: {info.filename}")
    require(
        info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
        f"Unsupported candidate ZIP compression method: {info.filename}",
    )
    require(
        0 <= info.file_size <= max_bytes,
        f"Candidate ZIP entry exceeds its size limit: {info.filename}",
    )
    require(info.compress_size >= 0, f"Invalid compressed size for candidate ZIP entry: {info.filename}")

    unix_mode = info.external_attr >> 16
    file_type = stat.S_IFMT(unix_mode)
    require(
        info.create_system != 3 or file_type in (0, stat.S_IFREG),
        f"Candidate ZIP entry must not be a symlink or special file: {info.filename}",
    )

    if info.file_size > 0:
        require(info.compress_size > 0, f"Invalid zero compressed size for candidate ZIP entry: {info.filename}")
        require(
            info.file_size <= info.compress_size * MAX_COMPRESSION_RATIO,
            f"Candidate ZIP entry exceeds the compression ratio limit: {info.filename}",
        )


def validate_open_archive(archive, product, version):
    limits = expected_entry_limits(product, version)
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    require(
        sorted(names) == sorted(limits),
        f"Candidate ZIP layout mismatch: {', '.join(sorted(names))}",
    )

    total_size = 0
    for entry in entries:
        validate_entry(entry, limits[entry.filename])
        total_size += entry.file_size
    require(
        total_size <= sum(limits.values()),
        "Candidate ZIP exceeds the total uncompressed size limit",
    )
    return entries


def publish_directory_noreplace(source, destination):
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    libc = ctypes.CDLL(None, use_errno=True)

    if sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        require(rename is not None, "Atomic candidate publication is unsupported on this runner")
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, source_bytes, -100, destination_bytes, 1)  # RENAME_NOREPLACE
    elif sys.platform == "darwin":
        rename = getattr(libc, "renamex_np", None)
        require(rename is not None, "Atomic candidate publication is unsupported on this runner")
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source_bytes, destination_bytes, 4)  # RENAME_EXCL
    else:
        raise CandidateArchiveError("Atomic candidate publication is unsupported on this runner")

    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in (errno.EEXIST, errno.ENOTEMPTY):
        raise CandidateArchiveError(f"Candidate destination already exists: {destination}")
    raise OSError(error_number, os.strerror(error_number), destination)


def inspect_candidate_archive(archive_path, product, version):
    with open_candidate_archive(archive_path, product, version) as archive:
        return tuple(entry.filename for entry in validate_open_archive(archive, product, version))


def copy_bounded(source, destination, expected_size, max_bytes):
    copied = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        copied += len(chunk)
        require(copied <= expected_size, "Candidate ZIP entry expanded beyond its declared size")
        require(copied <= max_bytes, "Candidate ZIP entry expanded beyond its product size limit")
        destination.write(chunk)
    require(copied == expected_size, "Candidate ZIP entry size does not match its central directory record")


def extract_candidate_archive(archive_path, product, version, destination):
    archive_path = Path(archive_path)
    destination = Path(destination)
    require(not os.path.lexists(destination), f"Candidate destination already exists: {destination}")

    with open_candidate_archive(archive_path, product, version) as archive:
        entries = validate_open_archive(archive, product, version)
        limits = expected_entry_limits(product, version)
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent))
        try:
            for entry in entries:
                target = staging / entry.filename
                with archive.open(entry, "r") as source, target.open("xb") as output:
                    copy_bounded(source, output, entry.file_size, limits[entry.filename])
                target.chmod(0o600)
            publish_directory_noreplace(staging, destination)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate and extract source-bound Happy release candidates.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("archive")
    inspect_parser.add_argument("product")
    inspect_parser.add_argument("version")

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("archive")
    extract_parser.add_argument("product")
    extract_parser.add_argument("version")
    extract_parser.add_argument("destination")

    args = parser.parse_args(argv)
    if args.command == "inspect":
        inspect_candidate_archive(args.archive, args.product, args.version)
    else:
        extract_candidate_archive(args.archive, args.product, args.version, args.destination)


if __name__ == "__main__":
    try:
        main()
    except CandidateArchiveError as error:
        raise SystemExit(str(error)) from error
