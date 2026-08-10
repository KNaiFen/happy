#!/usr/bin/env python3

import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile
import zlib


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))

import release_candidate_archive as archive_module  # noqa: E402
from release_candidate_archive import (  # noqa: E402
    CandidateArchiveError,
    EOCD_SIGNATURE,
    MAX_CENTRAL_DIRECTORY_BYTES,
    MAX_COMPRESSION_RATIO,
    PRODUCT_POLICIES,
    ZIP64_LOCATOR_SIGNATURE,
    expected_entry_limits,
    extract_candidate_archive,
    inspect_candidate_archive,
    validate_entry,
)


SOURCE_MANIFEST = b'{"schema":1}\n'
CENTRAL_DIRECTORY_SIGNATURE = b"PK\x01\x02"


class CandidateArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="happy-candidate-archive-")
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def archive_path(self, name="candidate.zip"):
        return self.root / name

    def write_cli_archive(self, archive_path, payload=b"verified CLI payload"):
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("release-candidate.json", SOURCE_MANIFEST)
            archive.writestr("happy-1.4.50.tgz", payload)

    def mutate_eocd(self, archive_path, mutator):
        contents = bytearray(archive_path.read_bytes())
        eocd_offset = contents.rfind(EOCD_SIGNATURE)
        self.assertGreaterEqual(eocd_offset, 0)
        mutator(contents, eocd_offset)
        archive_path.write_bytes(contents)

    def assert_preflight_rejected(self, archive_path, expected_message):
        with patch.object(archive_module.zipfile, "ZipFile") as zip_file:
            with self.assertRaisesRegex(CandidateArchiveError, expected_message):
                inspect_candidate_archive(archive_path, "cli", "1.4.50")
            zip_file.assert_not_called()

    def assert_rejected_without_output(self, archive_path, expected_message):
        destination = self.root / "extracted"
        with self.assertRaisesRegex(CandidateArchiveError, expected_message):
            extract_candidate_archive(archive_path, "cli", "1.4.50", destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".extracted.*")), [])

    def test_extracts_only_the_exact_regular_candidate_files(self):
        archive_path = self.archive_path()
        self.write_cli_archive(archive_path)
        destination = self.root / "extracted"

        self.assertEqual(
            inspect_candidate_archive(archive_path, "cli", "1.4.50"),
            ("release-candidate.json", "happy-1.4.50.tgz"),
        )
        extract_candidate_archive(archive_path, "cli", "1.4.50", destination)

        self.assertEqual((destination / "release-candidate.json").read_bytes(), SOURCE_MANIFEST)
        self.assertEqual((destination / "happy-1.4.50.tgz").read_bytes(), b"verified CLI payload")

    def test_rejects_path_traversal_and_newline_entries_before_creating_output(self):
        archive_path = self.archive_path()
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("release-candidate.json", SOURCE_MANIFEST)
            archive.writestr("../outside\nentry", b"outside")

        self.assert_rejected_without_output(archive_path, "layout mismatch")
        self.assertFalse((self.root / "outside\nentry").exists())
        self.assertFalse((self.root.parent / "outside\nentry").exists())

    def test_rejects_duplicate_entries_before_creating_output(self):
        archive_path = self.archive_path()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("happy-1.4.50.tgz", b"first")
                archive.writestr("happy-1.4.50.tgz", b"second")

        self.assert_rejected_without_output(archive_path, "layout mismatch")

    def test_rejects_unsafe_eocd_metadata_before_opening_the_central_directory(self):
        cases = [
            (
                "entry count",
                lambda contents, offset: struct.pack_into("<H", contents, offset + 10, 3),
                "EOCD entry count",
            ),
            (
                "multi-disk",
                lambda contents, offset: struct.pack_into("<H", contents, offset + 4, 1),
                "Multi-disk",
            ),
            (
                "ZIP64 sentinel",
                lambda contents, offset: struct.pack_into("<H", contents, offset + 10, 0xFFFF),
                "ZIP64",
            ),
            (
                "central directory size",
                lambda contents, offset: struct.pack_into(
                    "<I", contents, offset + 12, MAX_CENTRAL_DIRECTORY_BYTES + 1
                ),
                "central directory exceeds",
            ),
            (
                "central directory bounds",
                lambda contents, offset: struct.pack_into("<I", contents, offset + 16, offset),
                "central directory is outside",
            ),
        ]
        for index, (name, mutate, expected) in enumerate(cases):
            with self.subTest(name=name):
                archive_path = self.archive_path(f"candidate-{index}.zip")
                self.write_cli_archive(archive_path)
                self.mutate_eocd(archive_path, mutate)
                self.assert_preflight_rejected(archive_path, expected)

    def test_rejects_zip64_locator_and_missing_eocd_before_opening_zipfile(self):
        archive_path = self.archive_path("zip64-locator.zip")
        self.write_cli_archive(archive_path)

        def insert_zip64_locator(contents, offset):
            contents[offset:offset] = ZIP64_LOCATOR_SIGNATURE + bytes(16)

        self.mutate_eocd(archive_path, insert_zip64_locator)
        self.assert_preflight_rejected(archive_path, "ZIP64")

        missing_eocd = self.archive_path("missing-eocd.zip")
        self.write_cli_archive(missing_eocd)
        contents = missing_eocd.read_bytes()
        missing_eocd.write_bytes(contents[: contents.rfind(EOCD_SIGNATURE)])
        self.assert_preflight_rejected(missing_eocd, "unambiguous EOCD")

    def test_rejects_a_central_directory_entry_from_another_disk(self):
        archive_path = self.archive_path("multi-disk-entry.zip")
        self.write_cli_archive(archive_path)
        contents = bytearray(archive_path.read_bytes())
        entry_offset = contents.find(CENTRAL_DIRECTORY_SIGNATURE)
        self.assertGreaterEqual(entry_offset, 0)
        struct.pack_into("<H", contents, entry_offset + 34, 1)
        archive_path.write_bytes(contents)

        self.assert_rejected_without_output(archive_path, "Multi-disk")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO validation requires POSIX")
    def test_rejects_a_fifo_without_blocking(self):
        fifo_path = self.root / "candidate.fifo"
        os.mkfifo(fifo_path)
        result = subprocess.run(
            [
                sys.executable,
                str(Path(archive_module.__file__)),
                "inspect",
                str(fifo_path),
                "cli",
                "1.4.50",
            ],
            capture_output=True,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            text=True,
            timeout=2,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a regular file", result.stderr)

    def test_archive_path_replacement_does_not_change_the_open_file(self):
        archive_path = self.archive_path("candidate-original.zip")
        replacement_path = self.archive_path("candidate-replacement.zip")
        self.write_cli_archive(archive_path)
        replacement_path.write_bytes(b"not a ZIP")
        validate_eocd = archive_module.validate_zip_eocd

        def validate_and_replace(source, archive_size, expected_entries):
            validate_eocd(source, archive_size, expected_entries)
            os.replace(replacement_path, archive_path)

        with patch.object(archive_module, "validate_zip_eocd", side_effect=validate_and_replace):
            self.assertEqual(
                inspect_candidate_archive(archive_path, "cli", "1.4.50"),
                ("release-candidate.json", "happy-1.4.50.tgz"),
            )

    def test_accepts_the_maximum_standard_zip_comment(self):
        archive_path = self.archive_path("max-comment.zip")
        self.write_cli_archive(archive_path)
        with zipfile.ZipFile(archive_path, "a") as archive:
            archive.comment = b"x" * 0xFFFF

        self.assertEqual(
            inspect_candidate_archive(archive_path, "cli", "1.4.50"),
            ("release-candidate.json", "happy-1.4.50.tgz"),
        )

    def test_rejects_expected_entry_policy_drift(self):
        expected_entries = PRODUCT_POLICIES["cli"]["expectedEntries"]
        try:
            PRODUCT_POLICIES["cli"]["expectedEntries"] = expected_entries + 1
            with self.assertRaisesRegex(CandidateArchiveError, "does not match payload policy"):
                expected_entry_limits("cli", "1.4.50")
        finally:
            PRODUCT_POLICIES["cli"]["expectedEntries"] = expected_entries

    def test_rejects_existing_and_dangling_destination_entries(self):
        archive_path = self.archive_path()
        self.write_cli_archive(archive_path)
        destination = self.root / "extracted"
        destination.mkdir()
        with self.assertRaisesRegex(CandidateArchiveError, "destination already exists"):
            extract_candidate_archive(archive_path, "cli", "1.4.50", destination)

        destination.rmdir()
        destination.symlink_to(self.root / "missing", target_is_directory=True)
        self.assertTrue(destination.is_symlink())
        with self.assertRaisesRegex(CandidateArchiveError, "destination already exists"):
            extract_candidate_archive(archive_path, "cli", "1.4.50", destination)

    def test_atomic_publication_does_not_replace_a_racing_destination(self):
        archive_path = self.archive_path()
        self.write_cli_archive(archive_path)
        destination = self.root / "extracted"
        original_copy = archive_module.copy_bounded
        created = False

        def copy_and_create_destination(*args, **kwargs):
            nonlocal created
            original_copy(*args, **kwargs)
            if not created:
                destination.mkdir()
                (destination / "racing-marker").write_text("preserve", encoding="utf-8")
                created = True

        with patch.object(archive_module, "copy_bounded", side_effect=copy_and_create_destination):
            with self.assertRaisesRegex(CandidateArchiveError, "destination already exists"):
                extract_candidate_archive(archive_path, "cli", "1.4.50", destination)
        self.assertEqual((destination / "racing-marker").read_text(encoding="utf-8"), "preserve")
        self.assertEqual(list(self.root.glob(".extracted.*")), [])

    def test_rejects_symlinks_before_creating_output(self):
        archive_path = self.archive_path()
        link = zipfile.ZipInfo("happy-1.4.50.tgz")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("release-candidate.json", SOURCE_MANIFEST)
            archive.writestr(link, "target")

        self.assert_rejected_without_output(archive_path, "symlink or special file")

    def test_rejects_high_compression_ratio_before_creating_output(self):
        archive_path = self.archive_path()
        payload = b"0" * (2 * 1024 * 1024)
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("release-candidate.json", SOURCE_MANIFEST)
            archive.writestr("happy-1.4.50.tgz", payload)

        self.assertGreater(len(payload) / archive_path.stat().st_size, MAX_COMPRESSION_RATIO)
        self.assert_rejected_without_output(archive_path, "compression ratio limit")

    def test_rejects_entry_size_above_the_product_policy(self):
        limit = expected_entry_limits("cli", "1.4.50")["happy-1.4.50.tgz"]
        entry = zipfile.ZipInfo("happy-1.4.50.tgz")
        entry.file_size = limit + 1
        entry.compress_size = limit + 1

        with self.assertRaisesRegex(CandidateArchiveError, "size limit"):
            validate_entry(entry, limit)

    def test_rejects_encrypted_entries(self):
        entry = zipfile.ZipInfo("happy-1.4.50.tgz")
        entry.flag_bits |= 0x1

        with self.assertRaisesRegex(CandidateArchiveError, "Encrypted"):
            validate_entry(entry, 1024)

    def test_removes_partial_output_when_crc_validation_fails(self):
        archive_path = self.archive_path()
        unique_payload = b"unique-payload-for-crc-validation"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("release-candidate.json", SOURCE_MANIFEST)
            archive.writestr("happy-1.4.50.tgz", unique_payload)
        corrupted = bytearray(archive_path.read_bytes())
        payload_offset = corrupted.index(unique_payload)
        corrupted[payload_offset] ^= 0x1
        archive_path.write_bytes(corrupted)

        self.assert_rejected_without_output(archive_path, "Invalid candidate ZIP")

    def test_removes_partial_output_when_deflate_stream_is_invalid(self):
        archive_path = self.archive_path()
        self.write_cli_archive(archive_path)
        with zipfile.ZipFile(archive_path, "r") as archive:
            payload = archive.getinfo("happy-1.4.50.tgz")

        corrupted = bytearray(archive_path.read_bytes())
        filename_length, extra_length = struct.unpack_from("<HH", corrupted, payload.header_offset + 26)
        payload_offset = payload.header_offset + 30 + filename_length + extra_length
        corrupted[payload_offset] = (corrupted[payload_offset] & 0xF8) | 0x07
        archive_path.write_bytes(corrupted)

        with self.assertRaises(zlib.error):
            with zipfile.ZipFile(archive_path, "r") as archive:
                archive.read("happy-1.4.50.tgz")
        self.assert_rejected_without_output(archive_path, "Invalid candidate ZIP")


if __name__ == "__main__":
    unittest.main()
