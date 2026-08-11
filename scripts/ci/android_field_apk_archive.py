#!/usr/bin/env python3

import argparse
import ctypes
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
import zlib


ARCHIVE_MAX_BYTES = 192 * 1024 * 1024
APK_MAX_BYTES = 160 * 1024 * 1024
MANIFEST_MAX_BYTES = 64 * 1024
MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024
MAX_COMPRESSION_RATIO = 100
ENTRY_LIMITS = {
    "app-release.apk": APK_MAX_BYTES,
    "field-apk-manifest.json": MANIFEST_MAX_BYTES,
}
EOCD_SIGNATURE = b"PK\x05\x06"
EOCD_STRUCT = struct.Struct("<4s4H2IH")
ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
ZIP64_LOCATOR_BYTES = 20
ZIP_COMMENT_MAX_BYTES = 0xFFFF


class FieldApkArchiveError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise FieldApkArchiveError(message)


def validate_zip_eocd(source, archive_size):
    tail_size = min(archive_size, EOCD_STRUCT.size + ZIP_COMMENT_MAX_BYTES)
    tail_offset = archive_size - tail_size
    source.seek(tail_offset, os.SEEK_SET)
    tail = source.read(tail_size)
    require(len(tail) == tail_size, "Field APK ZIP ended while reading its EOCD record")

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

    require(len(candidates) == 1, "Field APK ZIP has no unambiguous EOCD record")
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
        "ZIP64 Field APK ZIP is not allowed",
    )
    if eocd_offset >= ZIP64_LOCATOR_BYTES:
        source.seek(eocd_offset - ZIP64_LOCATOR_BYTES, os.SEEK_SET)
        require(
            source.read(len(ZIP64_LOCATOR_SIGNATURE)) != ZIP64_LOCATOR_SIGNATURE,
            "ZIP64 Field APK ZIP is not allowed",
        )
    require(disk_number == 0 and central_directory_disk == 0, "Multi-disk Field APK ZIP is not allowed")
    require(
        entries_on_disk == entries_total == len(ENTRY_LIMITS),
        "Field APK ZIP entry count does not match its policy",
    )
    require(
        0 < central_directory_size <= MAX_CENTRAL_DIRECTORY_BYTES,
        "Field APK ZIP central directory exceeds its metadata limit",
    )
    require(
        central_directory_offset + central_directory_size <= eocd_offset,
        "Field APK ZIP central directory is outside archive bounds",
    )


@contextmanager
def open_field_apk_archive(archive_path):
    archive_path = Path(archive_path)
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
            require(stat.S_ISREG(details.st_mode), "Field APK ZIP must be a regular file")
            require(details.st_size > 0, "Field APK ZIP is empty")
            require(details.st_size <= ARCHIVE_MAX_BYTES, "Field APK ZIP exceeds its archive size limit")
            validate_zip_eocd(source, details.st_size)
            source.seek(0, os.SEEK_SET)
            with zipfile.ZipFile(source, "r", allowZip64=False) as archive:
                yield archive
    except FieldApkArchiveError:
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
        raise FieldApkArchiveError(f"Invalid Field APK ZIP: {error}") from error


def validate_entry(info, max_bytes):
    require(not info.is_dir(), f"Field APK ZIP entry must be a regular file: {info.filename}")
    require(info.volume == 0, "Multi-disk Field APK ZIP is not allowed")
    require((info.flag_bits & 0x1) == 0, f"Encrypted Field APK ZIP entry is not allowed: {info.filename}")
    require(
        info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
        f"Unsupported Field APK ZIP compression method: {info.filename}",
    )
    require(0 < info.file_size <= max_bytes, f"Field APK ZIP entry exceeds its size limit: {info.filename}")
    require(info.compress_size >= 0, f"Invalid compressed size for Field APK ZIP entry: {info.filename}")

    unix_mode = info.external_attr >> 16
    file_type = stat.S_IFMT(unix_mode)
    require(
        info.create_system != 3 or file_type in (0, stat.S_IFREG),
        f"Field APK ZIP entry must not be a symlink or special file: {info.filename}",
    )
    require(info.compress_size > 0, f"Invalid zero compressed size for Field APK ZIP entry: {info.filename}")
    require(
        info.file_size <= info.compress_size * MAX_COMPRESSION_RATIO,
        f"Field APK ZIP entry exceeds the compression ratio limit: {info.filename}",
    )


def validate_open_archive(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    require(sorted(names) == sorted(ENTRY_LIMITS), "Field APK ZIP layout does not match its policy")
    for entry in entries:
        validate_entry(entry, ENTRY_LIMITS[entry.filename])
    require(
        sum(entry.file_size for entry in entries) <= sum(ENTRY_LIMITS.values()),
        "Field APK ZIP exceeds its total uncompressed size limit",
    )
    return entries


def publish_directory_noreplace(source, destination):
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    libc = ctypes.CDLL(None, use_errno=True)

    if sys.platform.startswith("linux"):
        rename = getattr(libc, "renameat2", None)
        require(rename is not None, "Atomic Field APK publication is unsupported on this runner")
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, source_bytes, -100, destination_bytes, 1)
    elif sys.platform == "darwin":
        rename = getattr(libc, "renamex_np", None)
        require(rename is not None, "Atomic Field APK publication is unsupported on this runner")
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(source_bytes, destination_bytes, 4)
    else:
        raise FieldApkArchiveError("Atomic Field APK publication is unsupported on this runner")

    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in (errno.EEXIST, errno.ENOTEMPTY):
        raise FieldApkArchiveError(f"Field APK destination already exists: {destination}")
    raise OSError(error_number, os.strerror(error_number), destination)


def copy_bounded(source, destination, expected_size, max_bytes):
    copied = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        copied += len(chunk)
        require(copied <= expected_size, "Field APK ZIP entry expanded beyond its declared size")
        require(copied <= max_bytes, "Field APK ZIP entry expanded beyond its policy limit")
        destination.write(chunk)
    require(copied == expected_size, "Field APK ZIP entry size does not match its directory record")


def inspect_field_apk_archive(archive_path):
    with open_field_apk_archive(archive_path) as archive:
        return tuple(entry.filename for entry in validate_open_archive(archive))


def extract_field_apk_archive(archive_path, destination):
    archive_path = Path(archive_path)
    destination = Path(destination)
    require(not os.path.lexists(destination), f"Field APK destination already exists: {destination}")

    with open_field_apk_archive(archive_path) as archive:
        entries = validate_open_archive(archive)
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent))
        try:
            for entry in entries:
                target = staging / entry.filename
                with archive.open(entry, "r") as source, target.open("xb") as output:
                    copy_bounded(source, output, entry.file_size, ENTRY_LIMITS[entry.filename])
                target.chmod(0o600)
            publish_directory_noreplace(staging, destination)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate and extract a bounded Android Field APK artifact.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("archive")
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("archive")
    extract_parser.add_argument("destination")
    args = parser.parse_args(argv)
    if args.command == "inspect":
        inspect_field_apk_archive(args.archive)
    else:
        extract_field_apk_archive(args.archive, args.destination)


if __name__ == "__main__":
    try:
        main()
    except FieldApkArchiveError as error:
        raise SystemExit(str(error)) from error
