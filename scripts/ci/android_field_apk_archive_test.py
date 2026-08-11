#!/usr/bin/env python3

from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))

import android_field_apk_archive as archive_module  # noqa: E402
from android_field_apk_archive import (  # noqa: E402
    APK_MAX_BYTES,
    EOCD_SIGNATURE,
    FieldApkArchiveError,
    ZIP64_LOCATOR_SIGNATURE,
    extract_field_apk_archive,
    inspect_field_apk_archive,
    validate_entry,
)


MANIFEST = b'{"schemaVersion":1}\n'
APK = b"verified field apk payload"


class FieldApkArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(prefix="happy-field-apk-archive-")
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def archive_path(self, name="field-apk.zip"):
        return self.root / name

    def write_archive(self, archive_path, apk=APK, extra_entries=()):
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("field-apk-manifest.json", MANIFEST)
            archive.writestr("app-release.apk", apk)
            for name, value in extra_entries:
                archive.writestr(name, value)

    def mutate_eocd(self, archive_path, mutator):
        contents = bytearray(archive_path.read_bytes())
        offset = contents.rfind(EOCD_SIGNATURE)
        self.assertGreaterEqual(offset, 0)
        mutator(contents, offset)
        archive_path.write_bytes(contents)

    def assert_rejected_without_output(self, archive_path, message):
        destination = self.root / "extracted"
        with self.assertRaisesRegex(FieldApkArchiveError, message):
            extract_field_apk_archive(archive_path, destination)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".extracted.*")), [])

    def test_extracts_only_the_exact_regular_artifact_files(self):
        archive_path = self.archive_path()
        self.write_archive(archive_path)
        destination = self.root / "extracted"

        self.assertEqual(
            inspect_field_apk_archive(archive_path),
            ("field-apk-manifest.json", "app-release.apk"),
        )
        extract_field_apk_archive(archive_path, destination)
        self.assertEqual((destination / "field-apk-manifest.json").read_bytes(), MANIFEST)
        self.assertEqual((destination / "app-release.apk").read_bytes(), APK)

    def test_rejects_extra_and_traversal_entries(self):
        for name in ("extra.txt", "../app-release.apk", "/absolute"):
            archive_path = self.archive_path(name.replace("/", "_") + ".zip")
            self.write_archive(archive_path, extra_entries=((name, b"unexpected"),))
            self.assert_rejected_without_output(archive_path, "entry count|layout")

    def test_rejects_duplicate_entries(self):
        archive_path = self.archive_path()
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("field-apk-manifest.json", MANIFEST)
            archive.writestr("app-release.apk", APK)
            with self.assertWarns(UserWarning):
                archive.writestr("app-release.apk", b"duplicate")
        self.assert_rejected_without_output(archive_path, "entry count|layout")

    def test_rejects_symlinks_and_special_files(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600):
            archive_path = self.archive_path(f"mode-{mode}.zip")
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("field-apk-manifest.json", MANIFEST)
                entry = zipfile.ZipInfo("app-release.apk")
                entry.create_system = 3
                entry.external_attr = mode << 16
                archive.writestr(entry, APK)
            self.assert_rejected_without_output(archive_path, "symlink or special file")

    def test_rejects_encryption_and_unsupported_compression_flags(self):
        entry = zipfile.ZipInfo("app-release.apk")
        entry.file_size = len(APK)
        entry.compress_size = len(APK)
        entry.flag_bits = 1
        with self.assertRaisesRegex(FieldApkArchiveError, "Encrypted"):
            validate_entry(entry, APK_MAX_BYTES)
        entry.flag_bits = 0
        entry.compress_type = 99
        with self.assertRaisesRegex(FieldApkArchiveError, "Unsupported"):
            validate_entry(entry, APK_MAX_BYTES)

    def test_rejects_high_compression_ratio(self):
        archive_path = self.archive_path()
        self.write_archive(archive_path, apk=b"0" * (1024 * 1024))
        self.assert_rejected_without_output(archive_path, "compression ratio")

    def test_rejects_zip64_locator_and_multi_disk_eocd_before_zipfile(self):
        archive_path = self.archive_path("zip64.zip")
        self.write_archive(archive_path)

        def add_zip64_locator(contents, offset):
            contents[offset - 20:offset - 16] = ZIP64_LOCATOR_SIGNATURE

        self.mutate_eocd(archive_path, add_zip64_locator)
        with patch.object(archive_module.zipfile, "ZipFile") as zip_file:
            with self.assertRaisesRegex(FieldApkArchiveError, "ZIP64"):
                inspect_field_apk_archive(archive_path)
            zip_file.assert_not_called()

        archive_path = self.archive_path("multi-disk.zip")
        self.write_archive(archive_path)

        def set_disk(contents, offset):
            struct.pack_into("<H", contents, offset + 4, 1)

        self.mutate_eocd(archive_path, set_disk)
        with patch.object(archive_module.zipfile, "ZipFile") as zip_file:
            with self.assertRaisesRegex(FieldApkArchiveError, "Multi-disk"):
                inspect_field_apk_archive(archive_path)
            zip_file.assert_not_called()

    def test_rejects_an_existing_destination_without_overwrite(self):
        archive_path = self.archive_path()
        self.write_archive(archive_path)
        destination = self.root / "extracted"
        destination.mkdir()
        sentinel = destination / "keep"
        sentinel.write_text("preserve", encoding="utf-8")
        with self.assertRaisesRegex(FieldApkArchiveError, "already exists"):
            extract_field_apk_archive(archive_path, destination)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_rejects_crc_failure_and_cleans_staging_output(self):
        archive_path = self.archive_path()
        self.write_archive(archive_path)
        contents = bytearray(archive_path.read_bytes())
        with zipfile.ZipFile(archive_path, "r") as archive:
            entry = archive.getinfo("app-release.apk")
            data_offset = entry.header_offset + 30 + len(entry.filename.encode()) + len(entry.extra)
        contents[data_offset] ^= 0xFF
        archive_path.write_bytes(contents)
        self.assert_rejected_without_output(archive_path, "Invalid Field APK ZIP")


if __name__ == "__main__":
    unittest.main()
