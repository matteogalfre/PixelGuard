"""PixelGuard - local Android media backup over ADB."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import List, Optional, Tuple

from dateutil.relativedelta import relativedelta
from PyQt5.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt5.QtGui import QIcon
from PyQt5.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QFileDialog, QFrame,
    QGridLayout, QHBoxLayout, QLabel, QLineEdit, QListWidget, QMainWindow,
    QMenu, QPlainTextEdit, QProgressBar, QPushButton, QSpinBox, QSplitter,
    QTreeWidget, QTreeWidgetItem, QVBoxLayout, QWidget,
)

APP_NAME = "PixelGuard"
APP_VERSION = "2.0.0"

DEFAULT_TARGET = os.path.expanduser(
    r"~\Desktop\Photos Samsung Matt\1 un\2 deux\3 trois"
)

DEFAULT_SOURCES: List[str] = [
    "/sdcard/DCIM/Camera",
    "/sdcard/Movies/AdobeLightroom",
    "/sdcard/Pictures/AdobeLightroom",
    "/sdcard/Download/Quick Share",
    "/sdcard/Download/WeTransfer",
    "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video",
    "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images",
]

PHOTO_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp",
    ".dng", ".tif", ".tiff", ".raw", ".bmp",
}
VIDEO_EXTS = {
    ".mp4", ".mov", ".avi", ".wmv", ".mkv", ".webm", ".3gp",
    ".m4v", ".insv", ".mpg", ".mpeg",
}

CONFIG_DIR = Path(os.environ.get("APPDATA") or os.path.expanduser("~")) / APP_NAME
SETTINGS_FILE = CONFIG_DIR / "settings.json"
LOG_FILE = CONFIG_DIR / "pixelguard.log"

MONTHS_FR = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_FILENAME_DATE_RES = [
    re.compile(r"^(?P<y>\d{4})[-_]?(?P<m>\d{2})[-_]?\d{2}"),
    re.compile(r"^IMG[_-](?P<y>\d{4})(?P<m>\d{2})\d{2}"),
    re.compile(r"^VID[_-](?P<y>\d{4})(?P<m>\d{2})\d{2}"),
    re.compile(r"^PXL_(?P<y>\d{4})(?P<m>\d{2})\d{2}"),
    re.compile(r"^Screenshot[_-](?P<y>\d{4})(?P<m>\d{2})\d{2}"),
    re.compile(r"^(?:IMG|VID)-(?P<y>\d{4})(?P<m>\d{2})\d{2}-WA"),
    re.compile(r"(?P<y>\d{4})[-_:](?P<m>\d{2})[-_:]\d{2}[ _T]\d{2}"),
]


def detect_year_month_from_name(name: str) -> Optional[Tuple[int, int]]:
    base = os.path.basename(name)
    for pat in _FILENAME_DATE_RES:
        m = pat.search(base)
        if not m:
            continue
        try:
            y, mo = int(m.group("y")), int(m.group("m"))
        except (ValueError, IndexError):
            continue
        if 1970 <= y <= 2100 and 1 <= mo <= 12:
            return y, mo
    return None


def is_media_file(name: str, photos: bool, videos: bool) -> bool:
    ext = os.path.splitext(name)[1].lower()
    if photos and ext in PHOTO_EXTS:
        return True
    if videos and ext in VIDEO_EXTS:
        return True
    return False


def human_bytes(n: float) -> str:
    if n is None or n < 0:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def human_duration(seconds: float) -> str:
    if not seconds or seconds <= 0 or seconds != seconds:
        return "—"
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, sec = divmod(s, 60)
    if m < 60:
        return f"{m}m {sec:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


def sanitize_path_segment(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().rstrip(". ")
    return cleaned or "_"


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@dataclass
class Settings:
    target_folder: str = DEFAULT_TARGET
    source_folders: List[str] = field(default_factory=lambda: list(DEFAULT_SOURCES))
    filter_photos: bool = True
    filter_videos: bool = True
    max_workers: int = 4
    last_device_serial: Optional[str] = None
    use_mtime_fallback: bool = True
    recursive_scan: bool = True

    @classmethod
    def load(cls) -> "Settings":
        try:
            if SETTINGS_FILE.is_file():
                data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
                allowed = set(cls().__dict__.keys())
                data = {k: v for k, v in data.items() if k in allowed}
                return cls(**data)
        except Exception:
            logging.exception("Failed to load settings")
        return cls()

    def save(self) -> None:
        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            SETTINGS_FILE.write_text(
                json.dumps(asdict(self), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            logging.exception("Failed to save settings")


# ---------------------------------------------------------------------------
# ADB wrapper
# ---------------------------------------------------------------------------
@dataclass
class AdbDevice:
    serial: str
    state: str
    model: str = ""


@dataclass
class RemoteFile:
    full_path: str
    size: int
    mtime: int

    @property
    def name(self) -> str:
        return os.path.basename(self.full_path)


class Adb:
    def __init__(self, adb_path: str):
        self.adb_path = adb_path
        self.serial: Optional[str] = None

    def _base(self) -> List[str]:
        cmd = [self.adb_path]
        if self.serial:
            cmd += ["-s", self.serial]
        return cmd

    def _run(self, args: List[str], timeout: float = 30.0) -> subprocess.CompletedProcess:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )

    def start_server(self) -> None:
        try:
            self._run([self.adb_path, "start-server"], timeout=15)
        except Exception:
            logging.exception("adb start-server failed")

    def list_devices(self) -> List[AdbDevice]:
        try:
            res = self._run([self.adb_path, "devices", "-l"], timeout=5)
        except Exception:
            return []
        devices: List[AdbDevice] = []
        for line in res.stdout.splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            serial, state = parts[0], parts[1]
            model = ""
            for p in parts[2:]:
                if p.startswith("model:"):
                    model = p.split(":", 1)[1].replace("_", " ")
                    break
            devices.append(AdbDevice(serial=serial, state=state, model=model))
        return devices

    def shell(self, command: str, timeout: float = 60.0) -> Tuple[int, str, str]:
        try:
            res = self._run(self._base() + ["shell", command], timeout=timeout)
            return res.returncode, res.stdout, res.stderr
        except subprocess.TimeoutExpired:
            return 124, "", "timeout"
        except Exception as e:
            return 1, "", str(e)

    def list_files(self, remote_dir: str, recursive: bool = False) -> List[RemoteFile]:
        depth = "" if recursive else "-maxdepth 1"
        cmd = (
            f"find {sh_quote(remote_dir)} {depth} -type f "
            f'-exec stat -c "%n|%s|%Y" {{}} +'
        )
        rc, out, _ = self.shell(cmd, timeout=120)
        files: List[RemoteFile] = []
        if rc == 0 and out:
            for line in out.splitlines():
                line = line.strip()
                if not line:
                    continue
                parts = line.rsplit("|", 2)
                if len(parts) != 3:
                    continue
                full, size_s, mtime_s = parts
                try:
                    files.append(RemoteFile(full, int(size_s), int(mtime_s)))
                except ValueError:
                    continue
            return files
        # Fallback: plain ls (no metadata)
        rc2, out2, _ = self.shell(f"ls -1 {sh_quote(remote_dir)}", timeout=30)
        if rc2 != 0:
            return []
        return [
            RemoteFile(full_path=f"{remote_dir.rstrip('/')}/{l.strip()}",
                       size=-1, mtime=0)
            for l in out2.splitlines() if l.strip()
        ]

    def list_subdirs(self, remote_dir: str) -> List[str]:
        cmd = f"find {sh_quote(remote_dir.rstrip('/'))} -mindepth 1 -maxdepth 1 -type d"
        rc, out, _ = self.shell(cmd, timeout=20)
        if rc != 0:
            return []
        return [l.strip() for l in out.splitlines() if l.strip()]

    def path_exists(self, remote_path: str) -> bool:
        rc, _, _ = self.shell(
            f"[ -e {sh_quote(remote_path)} ] && echo 1 || echo 0", timeout=10
        )
        return rc == 0

    def pull(self, remote: str, local: str, timeout: float = 1800.0) -> Tuple[bool, str]:
        try:
            res = self._run(
                self._base() + ["pull", "-a", remote, local], timeout=timeout
            )
            if res.returncode == 0:
                return True, ""
            return False, (res.stderr or res.stdout).strip()
        except subprocess.TimeoutExpired:
            return False, "timeout"
        except Exception as e:
            return False, str(e)


# ---------------------------------------------------------------------------
# Transfer worker
# ---------------------------------------------------------------------------
@dataclass
class TransferItem:
    source_root: str
    full_path: str
    rel_path: str
    size: int
    mtime: int

    @property
    def name(self) -> str:
        return os.path.basename(self.full_path)


class TransferWorker(QThread):
    log = pyqtSignal(str)
    progress = pyqtSignal(dict)
    started_planning = pyqtSignal()
    finished_with = pyqtSignal(dict)

    def __init__(
        self,
        adb: Adb,
        target_dir: str,
        source_dirs: List[str],
        year: int,
        month: int,
        photos: bool,
        videos: bool,
        use_mtime: bool,
        recursive: bool,
        max_workers: int,
        parent=None,
    ):
        super().__init__(parent)
        self.adb = adb
        self.target_dir = target_dir
        self.source_dirs = source_dirs
        self.year = year
        self.month = month
        self.photos = photos
        self.videos = videos
        self.use_mtime = use_mtime
        self.recursive = recursive
        self.max_workers = max_workers
        self._stop = False
        self._executor: Optional[ThreadPoolExecutor] = None

    def stop(self) -> None:
        self._stop = True
        if self._executor is not None:
            try:
                self._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass

    def _matches_month(self, item: TransferItem) -> bool:
        ym = detect_year_month_from_name(item.name)
        if ym is not None:
            return ym == (self.year, self.month)
        if self.use_mtime and item.mtime > 0:
            try:
                d = datetime.fromtimestamp(item.mtime)
                return d.year == self.year and d.month == self.month
            except Exception:
                return False
        return False

    def _plan(self) -> List[TransferItem]:
        plan: List[TransferItem] = []
        seen = set()
        for src in self.source_dirs:
            if self._stop:
                return plan
            self.log.emit(f"Analyse : {src}")
            if not self.adb.path_exists(src):
                self.log.emit(f"  (introuvable, ignoré)")
                continue
            files = self.adb.list_files(src, recursive=self.recursive)
            kept = 0
            for rf in files:
                if self._stop:
                    return plan
                if not is_media_file(rf.name, self.photos, self.videos):
                    continue
                # Build relative path inside source root
                src_norm = src.rstrip("/")
                if rf.full_path.startswith(src_norm + "/"):
                    rel = rf.full_path[len(src_norm) + 1 :]
                else:
                    rel = rf.name
                item = TransferItem(
                    source_root=src_norm,
                    full_path=rf.full_path,
                    rel_path=rel,
                    size=rf.size,
                    mtime=rf.mtime,
                )
                if not self._matches_month(item):
                    continue
                key = (src_norm, rel)
                if key in seen:
                    continue
                seen.add(key)
                plan.append(item)
                kept += 1
            self.log.emit(f"  {kept} fichier(s) retenu(s) ({len(files)} scannés)")
        return plan

    def _local_target(self, item: TransferItem) -> str:
        # Flat layout: every file lands directly in target_dir.
        return os.path.join(self.target_dir, sanitize_path_segment(item.name))

    @staticmethod
    def _disambiguate(path: str) -> str:
        if not os.path.exists(path):
            return path
        root, ext = os.path.splitext(path)
        i = 1
        while True:
            candidate = f"{root} ({i}){ext}"
            if not os.path.exists(candidate):
                return candidate
            i += 1

    def _pull_one(self, item: TransferItem) -> Tuple[str, int, str]:
        if self._stop:
            return "cancelled", 0, ""
        target = self._local_target(item)
        try:
            os.makedirs(self.target_dir, exist_ok=True)
        except OSError as e:
            return "failed", 0, str(e)
        if os.path.isfile(target):
            try:
                local_size = os.path.getsize(target)
            except OSError:
                local_size = -1
            # Same size -> assume identical, skip silently.
            if item.size >= 0 and local_size == item.size:
                return "skipped", item.size, ""
            if item.size < 0 and local_size > 0:
                return "skipped", 0, ""
            # Different size -> probably a collision between two distinct files
            # coming from different sources. Don't overwrite, pick a new name.
            target = self._disambiguate(target)
        ok, err = self.adb.pull(item.full_path, target)
        if ok:
            return "ok", max(item.size, 0), ""
        return "failed", 0, err

    def run(self) -> None:
        try:
            os.makedirs(self.target_dir, exist_ok=True)
        except OSError as e:
            self.log.emit(f"Impossible de créer le dossier cible : {e}")
            self.finished_with.emit({"error": str(e)})
            return

        self.started_planning.emit()
        plan = self._plan()
        if self._stop:
            self.log.emit("Transfert annulé pendant l'analyse.")
            self.finished_with.emit(
                {"cancelled": True, "done": 0, "skipped": 0, "failed": 0,
                 "total_files": 0, "total_bytes": 0}
            )
            return

        total_files = len(plan)
        total_bytes = sum(max(p.size, 0) for p in plan)
        if total_files == 0:
            self.log.emit("Aucun fichier à transférer pour ce mois.")
            self.finished_with.emit(
                {"done": 0, "skipped": 0, "failed": 0,
                 "total_files": 0, "total_bytes": 0}
            )
            return

        self.log.emit(
            f"À transférer : {total_files} fichier(s) "
            f"({human_bytes(total_bytes)})"
        )

        done_files = 0
        done_bytes = 0
        transferred_bytes = 0
        ok_count = 0
        skipped = 0
        failed = 0
        start = time.monotonic()

        self._executor = ThreadPoolExecutor(max_workers=self.max_workers)
        futures = {self._executor.submit(self._pull_one, p): p for p in plan}
        try:
            for fut in as_completed(futures):
                if self._stop:
                    break
                item = futures[fut]
                try:
                    status, size, err = fut.result()
                except Exception as e:
                    status, size, err = "failed", 0, str(e)
                done_files += 1
                if status == "ok":
                    ok_count += 1
                    transferred_bytes += size
                    done_bytes += size
                    self.log.emit(f"OK    {item.name}  ({human_bytes(size)})")
                elif status == "skipped":
                    skipped += 1
                    done_bytes += max(item.size, 0)
                    self.log.emit(f"SKIP  {item.name} (déjà présent)")
                elif status == "cancelled":
                    pass
                else:
                    failed += 1
                    self.log.emit(f"FAIL  {item.name} — {err}")

                elapsed = max(time.monotonic() - start, 0.001)
                speed = transferred_bytes / elapsed
                remaining = max(total_bytes - done_bytes, 0)
                eta = remaining / speed if speed > 1024 else 0.0
                self.progress.emit({
                    "done_files": done_files,
                    "total_files": total_files,
                    "done_bytes": done_bytes,
                    "total_bytes": total_bytes,
                    "speed": speed,
                    "eta": eta,
                })
        finally:
            try:
                self._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            self._executor = None

        self.finished_with.emit({
            "done": ok_count,
            "skipped": skipped,
            "failed": failed,
            "total_files": total_files,
            "total_bytes": total_bytes,
            "cancelled": self._stop,
        })


# ---------------------------------------------------------------------------
# Style
# ---------------------------------------------------------------------------
STYLE_QSS = """
* {
    font-family: 'Segoe UI', 'San Francisco', 'Helvetica', sans-serif;
    font-size: 10pt;
}
QMainWindow, QDialog, QWidget {
    background-color: #0f172a;
    color: #e2e8f0;
}
QLabel { background: transparent; color: #e2e8f0; }
QLabel#H1 { font-size: 22pt; font-weight: 700; color: #f1f5f9; }
QLabel#Sub { color: #64748b; font-size: 9pt; }
QLabel#CardTitle { font-size: 11pt; font-weight: 600; color: #f1f5f9; padding-bottom: 2px; }
QLabel#StatValue { color: #f1f5f9; font-size: 14pt; font-weight: 600; }
QLabel#StatSub { color: #64748b; font-size: 8pt; }
QLabel#PathPreview {
    color: #cbd5e1; padding: 8px 10px;
    background: #0b1220; border: 1px solid #334155; border-radius: 6px;
}

QFrame#Card {
    background-color: #1e293b;
    border: 1px solid #334155;
    border-radius: 10px;
}

QPushButton {
    background-color: #334155;
    color: #f1f5f9;
    border: 1px solid #475569;
    border-radius: 6px;
    padding: 7px 14px;
    font-weight: 500;
}
QPushButton:hover  { background-color: #3f4d63; border-color: #64748b; }
QPushButton:pressed{ background-color: #29384b; }
QPushButton:disabled {
    background-color: #1e293b; color: #64748b; border-color: #334155;
}
QPushButton[role="primary"] {
    background-color: #06b6d4; border-color: #06b6d4;
    color: #0f172a; font-weight: 600;
}
QPushButton[role="primary"]:hover  { background-color: #0891b2; border-color: #0891b2; }
QPushButton[role="primary"]:pressed{ background-color: #0e7490; }
QPushButton[role="primary"]:disabled {
    background-color: #155e75; border-color: #155e75; color: #94a3b8;
}
QPushButton[role="danger"] {
    background-color: #b91c1c; border-color: #b91c1c;
    color: #fee2e2; font-weight: 600;
}
QPushButton[role="danger"]:hover  { background-color: #991b1b; }
QPushButton[role="danger"]:pressed{ background-color: #7f1d1d; }
QPushButton[role="danger"]:disabled {
    background-color: #7f1d1d; color: #94a3b8; border-color: #7f1d1d;
}
QPushButton[role="ghost"] {
    background: transparent; border: 1px solid transparent; color: #94a3b8;
}
QPushButton[role="ghost"]:hover {
    background: #1e293b; border-color: #334155; color: #e2e8f0;
}

QLineEdit, QPlainTextEdit, QComboBox, QSpinBox, QListWidget, QTreeWidget {
    background-color: #0b1220;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 8px;
    color: #f1f5f9;
    selection-background-color: #06b6d4;
    selection-color: #0f172a;
}
QPlainTextEdit {
    font-family: 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace;
    font-size: 9pt;
}
QListWidget::item, QTreeWidget::item { padding: 5px 6px; }
QListWidget::item:hover, QTreeWidget::item:hover { background-color: #1e293b; }
QListWidget::item:selected, QTreeWidget::item:selected {
    background-color: #155e75; color: #f1f5f9;
}
QHeaderView::section {
    background: #1e293b; color: #94a3b8;
    border: none; padding: 6px 8px;
}

QComboBox::drop-down { border: none; width: 22px; }
QComboBox QAbstractItemView {
    background-color: #1e293b; border: 1px solid #334155;
    selection-background-color: #06b6d4; selection-color: #0f172a;
    outline: 0;
}

QCheckBox { spacing: 8px; color: #e2e8f0; }
QCheckBox::indicator {
    width: 16px; height: 16px; border-radius: 4px;
    border: 1px solid #475569; background: #0b1220;
}
QCheckBox::indicator:hover   { border-color: #06b6d4; }
QCheckBox::indicator:checked { background: #06b6d4; border-color: #06b6d4; }

QProgressBar {
    background-color: #0b1220; border: 1px solid #334155;
    border-radius: 6px; height: 10px; text-align: center; color: #f1f5f9;
}
QProgressBar::chunk { background-color: #06b6d4; border-radius: 5px; }

QSplitter::handle { background: transparent; }

QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
QScrollBar::handle:vertical {
    background: #334155; border-radius: 5px; min-height: 30px;
}
QScrollBar::handle:vertical:hover { background: #475569; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar:horizontal { background: transparent; height: 10px; margin: 0; }
QScrollBar::handle:horizontal {
    background: #334155; border-radius: 5px; min-width: 30px;
}
QScrollBar::handle:horizontal:hover { background: #475569; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }

QFrame#Pill {
    background-color: #14532d; border: 1px solid #166534; border-radius: 14px;
}
QFrame#PillBad  { background-color: #4c0519; border: 1px solid #881337; border-radius: 14px; }
QFrame#PillWarn { background-color: #422006; border: 1px solid #78350f; border-radius: 14px; }
QLabel#DotOk   { color: #22c55e; font-size: 16pt; }
QLabel#DotBad  { color: #ef4444; font-size: 16pt; }
QLabel#DotWarn { color: #f59e0b; font-size: 16pt; }

QMenu {
    background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
    padding: 4px;
}
QMenu::item { padding: 6px 18px; border-radius: 4px; }
QMenu::item:selected { background: #334155; }

QToolTip {
    background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
    padding: 4px 6px;
}
"""


# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------
class StatusPill(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Pill")
        self.setFixedHeight(30)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 0, 14, 0)
        layout.setSpacing(8)
        self.dot = QLabel("●")
        self.dot.setObjectName("DotOk")
        self.label = QLabel("Connexion...")
        self.label.setStyleSheet("color: #f1f5f9; font-weight: 500;")
        layout.addWidget(self.dot)
        layout.addWidget(self.label)

    def set_state(self, kind: str, text: str) -> None:
        pill_id = {"ok": "Pill", "bad": "PillBad", "warn": "PillWarn"}[kind]
        dot_id = {"ok": "DotOk", "bad": "DotBad", "warn": "DotWarn"}[kind]
        self.setObjectName(pill_id)
        self.dot.setObjectName(dot_id)
        self.label.setText(text)
        for w in (self, self.dot):
            w.style().unpolish(w)
            w.style().polish(w)


class StatLabel(QWidget):
    def __init__(self, value: str, sub: str, parent=None):
        super().__init__(parent)
        l = QVBoxLayout(self)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(2)
        self.value = QLabel(value)
        self.value.setObjectName("StatValue")
        self.sub = QLabel(sub.upper())
        self.sub.setObjectName("StatSub")
        l.addWidget(self.value)
        l.addWidget(self.sub)

    def set_value(self, v: str) -> None:
        self.value.setText(v)


def make_card(title: Optional[str] = None) -> Tuple[QFrame, QVBoxLayout]:
    card = QFrame()
    card.setObjectName("Card")
    layout = QVBoxLayout(card)
    layout.setContentsMargins(16, 14, 16, 16)
    layout.setSpacing(10)
    if title:
        title_label = QLabel(title)
        title_label.setObjectName("CardTitle")
        layout.addWidget(title_label)
    return card, layout


# ---------------------------------------------------------------------------
# Device browser dialog
# ---------------------------------------------------------------------------
class DeviceBrowser(QDialog):
    folder_chosen = pyqtSignal(str)

    def __init__(self, adb: Adb, parent=None):
        super().__init__(parent)
        self.adb = adb
        self.setWindowTitle("Parcourir l'appareil")
        self.resize(560, 480)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        title = QLabel("Parcourir l'appareil")
        title.setObjectName("CardTitle")
        info = QLabel("Double-clic sur un dossier pour l'ajouter aux sources.")
        info.setObjectName("Sub")
        layout.addWidget(title)
        layout.addWidget(info)

        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["Dossier"])
        self.tree.itemExpanded.connect(self._on_expanded)
        self.tree.itemDoubleClicked.connect(self._on_pick)
        layout.addWidget(self.tree, 1)

        btns = QHBoxLayout()
        btns.addStretch(1)
        self.add_btn = QPushButton("Ajouter le dossier sélectionné")
        self.add_btn.setProperty("role", "primary")
        self.add_btn.clicked.connect(self._add_current)
        cancel = QPushButton("Fermer")
        cancel.setProperty("role", "ghost")
        cancel.clicked.connect(self.close)
        btns.addWidget(cancel)
        btns.addWidget(self.add_btn)
        layout.addLayout(btns)

        self._populate_root()

    def _populate_root(self) -> None:
        self._add_subfolders(self.tree.invisibleRootItem(), "/sdcard")
        # also expose Android/media as a top-level for media-scoped storage
        self._add_subfolders(self.tree.invisibleRootItem(), "/sdcard/Android/media")

    def _add_subfolders(self, parent, path: str) -> None:
        try:
            subdirs = self.adb.list_subdirs(path)
        except Exception:
            subdirs = []
        for sub in subdirs:
            name = os.path.basename(sub.rstrip("/"))
            it = QTreeWidgetItem(parent, [name])
            it.setData(0, Qt.UserRole, sub)
            it.setChildIndicatorPolicy(QTreeWidgetItem.ShowIndicator)

    def _on_expanded(self, item: QTreeWidgetItem) -> None:
        if item.childCount() == 0:
            path = item.data(0, Qt.UserRole)
            if path:
                self._add_subfolders(item, path)

    def _on_pick(self, item: QTreeWidgetItem, _col: int) -> None:
        folder = item.data(0, Qt.UserRole)
        if folder:
            self.folder_chosen.emit(folder)
            self.close()

    def _add_current(self) -> None:
        item = self.tree.currentItem()
        if item is None:
            return
        folder = item.data(0, Qt.UserRole)
        if folder:
            self.folder_chosen.emit(folder)
            self.close()


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1100, 740)
        self.setMinimumSize(900, 620)

        if getattr(sys, "frozen", False):
            base = Path(getattr(sys, "_MEIPASS", "."))
        else:
            base = Path(__file__).resolve().parent
        adb_candidate = base / "adb.exe"
        self.adb_path = str(adb_candidate) if adb_candidate.exists() else "adb.exe"
        icon_path = base / "icons" / "PixelGuard.png"
        if icon_path.is_file():
            self.setWindowIcon(QIcon(str(icon_path)))

        self.settings = Settings.load()
        self.adb = Adb(self.adb_path)
        self.adb.serial = self.settings.last_device_serial
        self.adb.start_server()

        self._worker: Optional[TransferWorker] = None
        self._last_state: Optional[str] = None
        self._last_default_subfolder: str = ""
        self._last_device_signature: Optional[Tuple[Tuple[str, str], ...]] = None
        self._initialized = False

        self._build_ui()
        self._apply_settings_to_ui()
        self._refresh_devices()
        self._initialized = True

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh_connection_status)
        self._timer.start(3000)

    # ----- UI building ------------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(20, 18, 20, 16)
        root.setSpacing(14)

        # Header
        header = QHBoxLayout()
        title_box = QVBoxLayout()
        title_box.setSpacing(0)
        title_lbl = QLabel(APP_NAME)
        title_lbl.setObjectName("H1")
        sub_lbl = QLabel(f"Backup local Android · v{APP_VERSION}")
        sub_lbl.setObjectName("Sub")
        title_box.addWidget(title_lbl)
        title_box.addWidget(sub_lbl)
        header.addLayout(title_box)
        header.addStretch(1)

        self.device_combo = QComboBox()
        self.device_combo.setMinimumWidth(220)
        self.device_combo.currentIndexChanged.connect(self._on_device_changed)
        self.refresh_btn = QPushButton("⟳")
        self.refresh_btn.setProperty("role", "ghost")
        self.refresh_btn.setFixedWidth(32)
        self.refresh_btn.setToolTip("Rafraîchir la liste des appareils")
        self.refresh_btn.clicked.connect(self._refresh_devices)
        self.status_pill = StatusPill()
        header.addWidget(self.device_combo)
        header.addWidget(self.refresh_btn)
        header.addSpacing(6)
        header.addWidget(self.status_pill)
        root.addLayout(header)

        # Body
        body = QSplitter(Qt.Horizontal)
        body.setHandleWidth(10)
        body.setChildrenCollapsible(False)

        # ---- LEFT column ----
        left = QWidget()
        left_l = QVBoxLayout(left)
        left_l.setContentsMargins(0, 0, 0, 0)
        left_l.setSpacing(12)

        # Destination card
        dest_card, dest_l = make_card("Destination")
        self.target_label = QLabel(self.settings.target_folder)
        self.target_label.setObjectName("PathPreview")
        self.target_label.setWordWrap(True)
        dest_btn_row = QHBoxLayout()
        self.change_target_btn = QPushButton("Changer")
        self.change_target_btn.clicked.connect(self._change_target)
        self.open_target_btn = QPushButton("Ouvrir")
        self.open_target_btn.setProperty("role", "ghost")
        self.open_target_btn.clicked.connect(self._open_target)
        dest_btn_row.addWidget(self.change_target_btn)
        dest_btn_row.addWidget(self.open_target_btn)
        dest_btn_row.addStretch(1)
        dest_l.addWidget(self.target_label)
        dest_l.addLayout(dest_btn_row)
        left_l.addWidget(dest_card)

        # Period card
        period_card, period_l = make_card("Période")
        self.month_combo = QComboBox()
        self._populate_months()
        self.month_combo.currentIndexChanged.connect(self._on_month_changed)
        period_l.addWidget(self.month_combo)
        sub_row = QHBoxLayout()
        sub_row.addWidget(QLabel("Sous-dossier :"))
        self.folder_name_input = QLineEdit()
        sub_row.addWidget(self.folder_name_input, 1)
        period_l.addLayout(sub_row)
        self.use_mtime_cb = QCheckBox(
            "Inclure les fichiers sans date dans le nom (utiliser mtime)"
        )
        period_l.addWidget(self.use_mtime_cb)
        self.recursive_cb = QCheckBox(
            "Scan récursif (parcourir aussi les sous-dossiers)"
        )
        period_l.addWidget(self.recursive_cb)
        left_l.addWidget(period_card)

        # Filters card
        filt_card, filt_l = make_card("Filtres")
        f_row = QHBoxLayout()
        self.photo_cb = QCheckBox("Photos")
        self.video_cb = QCheckBox("Vidéos")
        f_row.addWidget(self.photo_cb)
        f_row.addWidget(self.video_cb)
        f_row.addStretch(1)
        f_row.addWidget(QLabel("Workers :"))
        self.workers_spin = QSpinBox()
        self.workers_spin.setRange(1, 16)
        f_row.addWidget(self.workers_spin)
        filt_l.addLayout(f_row)
        left_l.addWidget(filt_card)

        # Sources card
        src_card, src_l = make_card("Dossiers source")
        self.source_list = QListWidget()
        self.source_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.source_list.customContextMenuRequested.connect(self._source_menu)
        src_l.addWidget(self.source_list, 1)
        src_btn_row = QHBoxLayout()
        self.add_src_btn = QPushButton("Ajouter")
        self.add_src_btn.clicked.connect(self._open_browser)
        self.rm_src_btn = QPushButton("Supprimer")
        self.rm_src_btn.setProperty("role", "ghost")
        self.rm_src_btn.clicked.connect(self._remove_source)
        self.reset_src_btn = QPushButton("Défaut")
        self.reset_src_btn.setProperty("role", "ghost")
        self.reset_src_btn.setToolTip("Réinitialiser à la liste par défaut")
        self.reset_src_btn.clicked.connect(self._reset_sources)
        src_btn_row.addWidget(self.add_src_btn)
        src_btn_row.addWidget(self.rm_src_btn)
        src_btn_row.addWidget(self.reset_src_btn)
        src_btn_row.addStretch(1)
        src_l.addLayout(src_btn_row)
        left_l.addWidget(src_card, 1)

        body.addWidget(left)

        # ---- RIGHT column ----
        right = QWidget()
        right_l = QVBoxLayout(right)
        right_l.setContentsMargins(0, 0, 0, 0)
        right_l.setSpacing(12)

        prog_card, prog_l = make_card("Transfert")
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(False)
        prog_l.addWidget(self.progress_bar)

        stats = QGridLayout()
        stats.setHorizontalSpacing(28)
        stats.setVerticalSpacing(0)
        self.stat_files = StatLabel("0 / 0", "Fichiers")
        self.stat_bytes = StatLabel("— / —", "Volume")
        self.stat_speed = StatLabel("—", "Débit")
        self.stat_eta = StatLabel("—", "Restant")
        for col, w in enumerate(
            (self.stat_files, self.stat_bytes, self.stat_speed, self.stat_eta)
        ):
            stats.addWidget(w, 0, col)
        prog_l.addLayout(stats)

        action_row = QHBoxLayout()
        self.start_btn = QPushButton("Lancer le transfert")
        self.start_btn.setProperty("role", "primary")
        self.start_btn.setMinimumHeight(40)
        self.start_btn.clicked.connect(self._start_transfer)
        self.stop_btn = QPushButton("Arrêter")
        self.stop_btn.setProperty("role", "danger")
        self.stop_btn.setMinimumHeight(40)
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self._stop_transfer)
        action_row.addWidget(self.start_btn, 2)
        action_row.addWidget(self.stop_btn, 1)
        prog_l.addLayout(action_row)
        right_l.addWidget(prog_card)

        log_card, log_l = make_card("Journal")
        self.log_area = QPlainTextEdit()
        self.log_area.setReadOnly(True)
        self.log_area.setMinimumHeight(180)
        log_l.addWidget(self.log_area)
        log_btn_row = QHBoxLayout()
        log_btn_row.addStretch(1)
        clear = QPushButton("Effacer")
        clear.setProperty("role", "ghost")
        clear.clicked.connect(self.log_area.clear)
        log_btn_row.addWidget(clear)
        log_l.addLayout(log_btn_row)
        right_l.addWidget(log_card, 1)

        body.addWidget(right)
        body.setStretchFactor(0, 1)
        body.setStretchFactor(1, 1)
        body.setSizes([470, 620])

        root.addWidget(body, 1)

    # ----- Settings <-> UI --------------------------------------------------
    def _populate_months(self) -> None:
        now = datetime.now()
        self.month_combo.clear()
        for i in range(36):
            d = now - relativedelta(months=i)
            text = f"{d.year} {MONTHS_FR[d.month - 1]}"
            self.month_combo.addItem(text, (d.year, d.month))

    def _apply_settings_to_ui(self) -> None:
        self.target_label.setText(self.settings.target_folder)
        self.photo_cb.setChecked(self.settings.filter_photos)
        self.video_cb.setChecked(self.settings.filter_videos)
        self.use_mtime_cb.setChecked(self.settings.use_mtime_fallback)
        self.recursive_cb.setChecked(self.settings.recursive_scan)
        self.workers_spin.setValue(self.settings.max_workers)
        self.source_list.clear()
        seen = set()
        for s in self.settings.source_folders:
            s = s.rstrip("/")
            if s and s not in seen:
                seen.add(s)
                self.source_list.addItem(s)

        y, m = self.month_combo.currentData()
        default_name = f"{y} {MONTHS_FR[m - 1]}"
        self.folder_name_input.setText(default_name)
        self._last_default_subfolder = default_name

        self.photo_cb.stateChanged.connect(self._save_settings_from_ui)
        self.video_cb.stateChanged.connect(self._save_settings_from_ui)
        self.use_mtime_cb.stateChanged.connect(self._save_settings_from_ui)
        self.recursive_cb.stateChanged.connect(self._save_settings_from_ui)
        self.workers_spin.valueChanged.connect(self._save_settings_from_ui)

    def _save_settings_from_ui(self) -> None:
        if not self._initialized:
            pass  # still allow saving once UI exists
        new = Settings(
            target_folder=self.target_label.text(),
            source_folders=[
                self.source_list.item(i).text()
                for i in range(self.source_list.count())
            ],
            filter_photos=self.photo_cb.isChecked(),
            filter_videos=self.video_cb.isChecked(),
            max_workers=self.workers_spin.value(),
            last_device_serial=self.adb.serial,
            use_mtime_fallback=self.use_mtime_cb.isChecked(),
            recursive_scan=self.recursive_cb.isChecked(),
        )
        if asdict(new) != asdict(self.settings):
            self.settings = new
            self.settings.save()

    # ----- Period handling --------------------------------------------------
    def _on_month_changed(self, _idx: int) -> None:
        data = self.month_combo.currentData()
        if not data:
            return
        y, m = data
        new_default = f"{y} {MONTHS_FR[m - 1]}"
        current = self.folder_name_input.text().strip()
        if not current or current == self._last_default_subfolder:
            self.folder_name_input.setText(new_default)
        self._last_default_subfolder = new_default

    # ----- Target folder ----------------------------------------------------
    def _change_target(self) -> None:
        new = QFileDialog.getExistingDirectory(
            self, "Dossier cible", self.settings.target_folder
        )
        if new:
            self.target_label.setText(new)
            self._save_settings_from_ui()

    def _open_target(self) -> None:
        sub = (self.folder_name_input.text().strip()
               or self._last_default_subfolder)
        full = os.path.join(self.settings.target_folder,
                            sanitize_path_segment(sub))
        target = full if os.path.isdir(full) else self.settings.target_folder
        if not os.path.isdir(target):
            try:
                os.makedirs(target, exist_ok=True)
            except OSError as e:
                self._log("error", f"Impossible d'ouvrir : {e}")
                return
        try:
            if sys.platform == "win32":
                os.startfile(target)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["xdg-open", target])
        except Exception as e:
            self._log("error", f"Ouverture : {e}")

    # ----- Sources ----------------------------------------------------------
    def _open_browser(self) -> None:
        devices = self.adb.list_devices()
        if not any(d.state == "device" for d in devices):
            self._log("warn", "Aucun appareil prêt. Branche et autorise le téléphone.")
            return
        dlg = DeviceBrowser(self.adb, self)
        dlg.folder_chosen.connect(self._add_source)
        dlg.exec_()

    def _add_source(self, folder: str) -> None:
        f = folder.rstrip("/")
        existing = {self.source_list.item(i).text()
                    for i in range(self.source_list.count())}
        if f and f not in existing:
            self.source_list.addItem(f)
            self._save_settings_from_ui()

    def _remove_source(self) -> None:
        item = self.source_list.currentItem()
        if item:
            self.source_list.takeItem(self.source_list.row(item))
            self._save_settings_from_ui()

    def _reset_sources(self) -> None:
        self.source_list.clear()
        for s in DEFAULT_SOURCES:
            self.source_list.addItem(s)
        self._save_settings_from_ui()

    def _source_menu(self, pos) -> None:
        menu = QMenu(self)
        a_remove = menu.addAction("Supprimer")
        a_clear = menu.addAction("Tout effacer")
        a_reset = menu.addAction("Restaurer la liste par défaut")
        chosen = menu.exec_(self.source_list.mapToGlobal(pos))
        if chosen == a_remove:
            self._remove_source()
        elif chosen == a_clear:
            self.source_list.clear()
            self._save_settings_from_ui()
        elif chosen == a_reset:
            self._reset_sources()

    # ----- Devices ----------------------------------------------------------
    def _refresh_devices(self, devices: Optional[List[AdbDevice]] = None) -> None:
        if devices is None:
            devices = self.adb.list_devices()
        self.device_combo.blockSignals(True)
        self.device_combo.clear()
        if not devices:
            self.device_combo.addItem("Aucun appareil", None)
            self.adb.serial = None
        else:
            for d in devices:
                label = d.model or d.serial
                if d.state != "device":
                    label += f"  ({d.state})"
                self.device_combo.addItem(label, d.serial)
            keep = -1
            if self.adb.serial:
                for i in range(self.device_combo.count()):
                    if self.device_combo.itemData(i) == self.adb.serial:
                        keep = i
                        break
            if keep < 0:
                # Prefer a fully-ready device over an unauthorized/offline one
                ready_idx = next(
                    (i for i, d in enumerate(devices) if d.state == "device"),
                    0,
                )
                keep = ready_idx
                self.adb.serial = self.device_combo.itemData(keep)
            self.device_combo.setCurrentIndex(keep)
        self.device_combo.blockSignals(False)
        self._last_device_signature = self._device_signature(devices)
        self._update_pill(devices)
        if self._initialized:
            self._save_settings_from_ui()

    def _on_device_changed(self, _idx: int) -> None:
        self.adb.serial = self.device_combo.currentData()
        self._save_settings_from_ui()
        self._update_pill(self.adb.list_devices())

    @staticmethod
    def _device_signature(devices: List[AdbDevice]) -> Tuple[Tuple[str, str], ...]:
        return tuple((d.serial, d.state) for d in devices)

    def _refresh_connection_status(self) -> None:
        devices = self.adb.list_devices()
        sig = self._device_signature(devices)
        # Refresh combo whenever topology *or* state changed (e.g.
        # unauthorized -> device should re-select the device).
        if sig != getattr(self, "_last_device_signature", None):
            self._refresh_devices(devices)
            return
        self._update_pill(devices)

    def _update_pill(self, devices: List[AdbDevice]) -> None:
        if not devices:
            state = "no-device"
            self.status_pill.set_state("bad", "Aucun appareil")
        else:
            cur = self.device_combo.currentData()
            d = next((d for d in devices if d.serial == cur), devices[0])
            if d.state == "device":
                state = "ok"
                self.status_pill.set_state("ok", d.model or d.serial)
            elif d.state == "unauthorized":
                state = "unauthorized"
                self.status_pill.set_state(
                    "warn", "Non autorisé · vérifie le téléphone"
                )
            elif d.state == "offline":
                state = "offline"
                self.status_pill.set_state("warn", "Hors-ligne")
            else:
                state = d.state
                self.status_pill.set_state("warn", d.state)

        if state != self._last_state:
            if state == "ok":
                self._log("info", "Smartphone connecté.")
            elif state == "no-device":
                self._log("warn", "Smartphone débranché.")
            elif state == "unauthorized":
                self._log(
                    "warn",
                    "Téléphone non autorisé. Accepte la demande à l'écran.",
                )
            else:
                self._log("warn", f"État ADB : {state}")
            self._last_state = state

    # ----- Logging ----------------------------------------------------------
    def _log(self, level: str, message: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        prefix = {"info": "·", "warn": "!", "error": "x"}.get(level, "·")
        self.log_area.appendPlainText(f"[{ts}] {prefix} {message}")
        if level == "info":
            logging.info(message)
        elif level == "warn":
            logging.warning(message)
        elif level == "error":
            logging.error(message)

    # ----- Transfer ---------------------------------------------------------
    def _start_transfer(self) -> None:
        if self._worker and self._worker.isRunning():
            return
        devices = self.adb.list_devices()
        ready = [d for d in devices if d.state == "device"]
        if not ready:
            unauthorized = [d for d in devices if d.state == "unauthorized"]
            if unauthorized:
                self._log(
                    "error",
                    "Téléphone non autorisé. Accepte la demande ADB à l'écran "
                    "puis ré-essaie.",
                )
            else:
                self._log(
                    "error",
                    "Aucun appareil prêt. Branche et autorise le téléphone.",
                )
            return
        # Auto-select a ready device if none is currently selected (e.g. the
        # combo still pointed at an unauthorized one when the user authorized).
        if not self.adb.serial or self.adb.serial not in {d.serial for d in ready}:
            self.adb.serial = ready[0].serial
            self._refresh_devices(devices)
        if self.source_list.count() == 0:
            self._log("error", "Ajoute au moins un dossier source.")
            return
        if not (self.photo_cb.isChecked() or self.video_cb.isChecked()):
            self._log("error", "Coche au moins photos ou vidéos.")
            return

        sub = sanitize_path_segment(
            self.folder_name_input.text().strip() or self._last_default_subfolder
        )
        target_dir = os.path.join(self.settings.target_folder, sub)
        sources = [
            self.source_list.item(i).text()
            for i in range(self.source_list.count())
        ]
        y, m = self.month_combo.currentData()
        self._save_settings_from_ui()

        self.progress_bar.setRange(0, 0)  # indeterminate while planning
        self.stat_files.set_value("…")
        self.stat_bytes.set_value("Analyse…")
        self.stat_speed.set_value("—")
        self.stat_eta.set_value("—")

        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)

        self._worker = TransferWorker(
            adb=self.adb,
            target_dir=target_dir,
            source_dirs=sources,
            year=y,
            month=m,
            photos=self.photo_cb.isChecked(),
            videos=self.video_cb.isChecked(),
            use_mtime=self.use_mtime_cb.isChecked(),
            recursive=self.recursive_cb.isChecked(),
            max_workers=self.workers_spin.value(),
        )
        self._worker.log.connect(lambda m: self._log("info", m))
        self._worker.progress.connect(self._on_progress)
        self._worker.started_planning.connect(
            lambda: self._log("info", "Analyse des dossiers...")
        )
        self._worker.finished_with.connect(self._on_finished)
        self._worker.start()

    def _stop_transfer(self) -> None:
        if self._worker and self._worker.isRunning():
            self._log("warn", "Arrêt demandé...")
            self._worker.stop()
            self.stop_btn.setEnabled(False)

    def _on_progress(self, info: dict) -> None:
        total_files = int(info.get("total_files", 0))
        done_files = int(info.get("done_files", 0))
        if self.progress_bar.maximum() != total_files:
            self.progress_bar.setRange(0, max(total_files, 1))
        self.progress_bar.setValue(done_files)

        self.stat_files.set_value(f"{done_files} / {total_files}")
        self.stat_bytes.set_value(
            f"{human_bytes(info.get('done_bytes', 0))} / "
            f"{human_bytes(info.get('total_bytes', 0))}"
        )
        self.stat_speed.set_value(
            f"{human_bytes(info.get('speed', 0))}/s"
        )
        self.stat_eta.set_value(human_duration(info.get("eta", 0)))

    def _on_finished(self, summary: dict) -> None:
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        if "error" in summary:
            self._log("error", f"Erreur : {summary['error']}")
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(0)
            return
        self.progress_bar.setRange(0, 100)
        if summary.get("cancelled"):
            self._log("warn", "Transfert annulé.")
        total = summary.get("total_files", 0)
        done = summary.get("done", 0)
        skipped = summary.get("skipped", 0)
        failed = summary.get("failed", 0)
        if total and (done + skipped) == total:
            self.progress_bar.setValue(100)
        self._log(
            "info",
            f"Terminé : {done} transférés · {skipped} déjà présents · "
            f"{failed} échec(s) sur {total}.",
        )
        try:
            QApplication.alert(self, 0)
        except Exception:
            pass

    # ----- Lifecycle --------------------------------------------------------
    def closeEvent(self, event) -> None:
        if self._worker and self._worker.isRunning():
            self._worker.stop()
            self._worker.wait(2000)
        self._save_settings_from_ui()
        super().closeEvent(event)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def setup_logging() -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    handler = RotatingFileHandler(
        LOG_FILE, maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        root.addHandler(handler)


def main() -> int:
    setup_logging()
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setStyle("Fusion")
    app.setStyleSheet(STYLE_QSS)
    win = MainWindow()
    win.show()
    return app.exec_()


if __name__ == "__main__":
    sys.exit(main())
