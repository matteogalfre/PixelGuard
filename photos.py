import os
import subprocess
from datetime import datetime
import re
import sys
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QPlainTextEdit, QWidget, QListWidget, QFileDialog, QTreeWidget, QTreeWidgetItem, 
    QDialog, QProgressBar, QGroupBox, QSplitter, QCheckBox, QComboBox, QMenu, QLineEdit
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer, QMetaObject, Q_ARG
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor
import queue
from PyQt5.QtGui import QIcon

class TransferThread(QThread):
    log = pyqtSignal(str)
    progress = pyqtSignal(int)
    finished = pyqtSignal()

    def __init__(self, app, max_workers=4):
        super().__init__()
        self.app = app
        self.stop_requested = False
        self.total_files = 0
        self.current_file = 0
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.queue = queue.Queue()

    def transfer_file_worker(self, args):
        source_folder, file, target_folder = args
        try:
            self.app.transfer_file(source_folder, file, target_folder)
            return True
        except Exception as e:
            self.log.emit(f"Erreur: {str(e)}")
            return False

    def run(self):
        if not self.app.target_folder:
            self.log.emit("Erreur : Veuillez sélectionner un dossier cible.")
            return

        selected_month_folder = self.app.folder_name_input.text()
        full_target_path = os.path.join(self.app.target_folder, selected_month_folder)
        os.makedirs(full_target_path, exist_ok=True)

        self.total_files = self.count_files_to_transfer()
        self.log.emit(f"Nombre total de fichiers à transférer : {self.total_files}")

        if self.total_files == 0:
            self.log.emit("Aucun fichier à transférer pour le mois sélectionné.")
            self.finished.emit()
            return

        futures = []
        for folder, pattern in self.app.source_folders:
            self.log.emit(f"Analyse du dossier : {folder}")
            files = self.app.list_files(folder)
            if files:
                for file in files:
                    if self.stop_requested:
                        self.log.emit("Transfert interrompu par l'utilisateur.")
                        return
                    if self.should_transfer_file(file, pattern):
                        future = self.executor.submit(
                            self.transfer_file_worker, 
                            (folder, file, full_target_path)
                        )
                        futures.append(future)
                        self.current_file += 1
                        progress = int((self.current_file / self.total_files) * 100)
                        self.progress.emit(progress)

        for future in futures:
            try:
                future.result()
            except Exception as e:
                self.log.emit(f"Erreur: {str(e)}")

        self.progress.emit(100)
        self.log.emit(f"Transfert terminé ! {self.current_file} fichiers transférés.")
        self.finished.emit()

    def count_files_to_transfer(self):
        count = 0
        for folder, pattern in self.app.source_folders:
            files = self.app.list_files(folder)
            for file in files:
                if self.should_transfer_file(file, pattern):
                    count += 1
        return count

    def should_transfer_file(self, file, pattern):
        if not self.app.is_selected_month(file, pattern):
            return False
        
        file_lower = file.lower()
        if self.app.filter_photos and not self.app.filter_videos:
            return any(file_lower.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif'])
        elif self.app.filter_videos and not self.app.filter_photos:
            return any(file_lower.endswith(ext) for ext in ['.mp4', '.mov', '.avi', '.wmv'])
        elif self.app.filter_photos and self.app.filter_videos:
            return True
        return False

class PhotoTransferApp(QMainWindow):
    def __init__(self):
        super().__init__()
        if getattr(sys, 'frozen', False):
            self.adb_path = os.path.join(sys._MEIPASS, 'adb.exe')
        else:
            self.adb_path = 'adb.exe'
        self.target_base_path = os.path.expanduser('~\\Desktop\\Photos Samsung Matt\\1 un\\2 deux\\3 trois')
        self.target_folder = self.target_base_path
        self.source_folders = [('/sdcard/DCIM/Camera', 'standard'), ('/sdcard/Movies/AdobeLightroom', 'standard'), ('/sdcard/Pictures/AdobeLightroom', 'standard')]
        self.selected_month = datetime.now()
        self.filter_photos = True
        self.filter_videos = True
        self.connection_status = None

        self.init_ui()
        self.setStyleSheet("""
            QWidget {
                background-color: #2b2b2b;
                color: white;
            }
            QPushButton {
                background-color: #3a3a3a;
                border: none;
                padding: 8px;
                border-radius: 4px;
                min-width: 100px;
                margin: 2px;
            }
            QPushButton:hover {
                background-color: #454545;
            }
            QPushButton:pressed {
                background-color: #505050;
            }
            QLabel {
                padding: 5px;
                font-weight: bold;
            }
            QListWidget, QPlainTextEdit {
                background-color: #323232;
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                padding: 5px;
            }
            QComboBox {
                background-color: #3a3a3a;
                border: none;
                border-radius: 4px;
                padding: 5px;
                min-width: 150px;
            }
            QLineEdit {
                background-color: #3a3a3a;
                border: none;
                border-radius: 4px;
                padding: 5px;
                min-width: 150px;
            }
            QGroupBox {
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                margin-top: 10px;
                padding-top: 10px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 3px 0 3px;
            }
            QCheckBox {
                spacing: 5px;
            }
            QCheckBox::indicator {
                width: 13px;
                height: 13px;
            }
        """)
        self.setWindowIcon(QIcon('icons/PixelGuard.png'))  # Set the window icon
        self.check_smartphone_connection()
        self.start_connection_timer()
        self.populate_source_list()

    def log(self, message):
        QMetaObject.invokeMethod(self.log_area, "appendPlainText", Q_ARG(str, message))

    def start_connection_timer(self):
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.check_smartphone_connection)
        self.timer.start(1000)  # Check every 5 seconds

    def check_smartphone_connection(self):
        if self.is_android_connected():
            if self.connection_status != "branché":
                self.log("Smartphone branché")
                self.connection_status = "branché"
        else:
            if self.connection_status != "débranché":
                self.log("Smartphone débranché")
                self.connection_status = "débranché"

    def is_android_connected(self):
        try:
            result = subprocess.run(
                [self.adb_path, 'get-state'],
                capture_output=True,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            return 'device' in result.stdout
        except Exception as e:
            self.log(f"Erreur lors de la vérification de la connexion Android: {e}")
            return False

    def populate_source_list(self):
        unique_folders = set()
        for folder, _ in self.source_folders:
            normalized_folder = folder.rstrip('/')
            if normalized_folder not in unique_folders:
                unique_folders.add(normalized_folder)
                self.source_list.addItem(normalized_folder)

    def init_ui(self):
        self.setWindowTitle("PixelGuard")
        self.setWindowIcon(QIcon('icons/PixelGuard.png'))
        self.setGeometry(200, 200, 800, 600)
        self.central_widget = QWidget()
        self.main_layout = QVBoxLayout(self.central_widget)

        self.init_folder_group()
        self.init_filter_group()
        self.init_source_group()
        self.init_transfer_controls()

        self.splitter = QSplitter(Qt.Vertical)
        top_widget = QWidget()
        top_layout = QVBoxLayout(top_widget)
        top_layout.addWidget(self.folder_group)
        top_layout.addWidget(self.filter_group)
        top_layout.addWidget(self.source_group)
        
        bottom_widget = QWidget()
        bottom_layout = QVBoxLayout(bottom_widget)
        bottom_layout.addLayout(self.transfer_layout)
        bottom_layout.addWidget(self.log_area)
        
        self.splitter.addWidget(top_widget)
        self.splitter.addWidget(bottom_widget)
        
        self.main_layout.addWidget(self.splitter)
        self.setCentralWidget(self.central_widget)

    def init_folder_group(self):
        self.folder_group = QGroupBox("Dossier cible")
        folder_layout = QVBoxLayout()
        
        self.target_label = QLabel(f"{self.target_folder}")
        self.change_folder_button = QPushButton("Changer le dossier cible")
        self.change_folder_button.clicked.connect(self.change_target_folder)
        
        folder_layout.addWidget(self.target_label)
        folder_layout.addWidget(self.change_folder_button)
        self.folder_group.setLayout(folder_layout)

    def init_filter_group(self):
        self.filter_group = QGroupBox("Filtres et période")
        filter_and_month_layout = QHBoxLayout()

        filter_layout = QVBoxLayout()
        self.photo_checkbox = QCheckBox("Photos")
        self.photo_checkbox.setChecked(True)
        self.video_checkbox = QCheckBox("Vidéos")
        self.video_checkbox.setChecked(True)
        filter_layout.addWidget(self.photo_checkbox)
        filter_layout.addWidget(self.video_checkbox)

        month_selector_layout = QVBoxLayout()
        self.month_selector = QComboBox()
        self.populate_month_selector()
        self.folder_name_input = QLineEdit()
        self.update_folder_name_input()
        month_selector_layout.addWidget(self.month_selector)
        month_selector_layout.addWidget(self.folder_name_input)

        filter_and_month_layout.addLayout(filter_layout)
        filter_and_month_layout.addStretch()
        filter_and_month_layout.addLayout(month_selector_layout)

        self.filter_group.setLayout(filter_and_month_layout)

    def init_source_group(self):
        self.source_group = QGroupBox("Dossiers source")
        source_layout = QVBoxLayout()
        self.source_list = QListWidget()
        self.source_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.source_list.customContextMenuRequested.connect(self.show_context_menu)
        
        source_buttons_layout = QHBoxLayout()
        self.add_source_button = QPushButton("Ajouter dossier")
        self.remove_source_button = QPushButton("Supprimer dossier")
        source_buttons_layout.addWidget(self.add_source_button)
        source_buttons_layout.addWidget(self.remove_source_button)
        
        source_layout.addWidget(self.source_list)
        source_layout.addLayout(source_buttons_layout)
        self.source_group.setLayout(source_layout)

    def init_transfer_controls(self):
        self.transfer_layout = QVBoxLayout()
        
        self.progress_bar = QProgressBar()
        self.progress_bar.setTextVisible(False)
        
        control_buttons_layout = QHBoxLayout()
        self.start_button = QPushButton("Lancer le transfert")
        self.start_button.setStyleSheet("""
            QPushButton {
                background-color: #2d5a27;
            }
            QPushButton:hover {
                background-color: #346c2d;
            }
            QPushButton:pressed {
                background-color: #3b7a33;
            }
        """)
        self.stop_button = QPushButton("Arrêter le transfert")
        self.stop_button.setStyleSheet("""
            QPushButton {
                background-color: #5a2727;
            }
            QPushButton:hover {
                background-color: #6c2d2d;
            }
            QPushButton:pressed {
                background-color: #7a3333;
            }
        """)
        
        control_buttons_layout.addWidget(self.start_button)
        control_buttons_layout.addWidget(self.stop_button)
        
        self.transfer_layout.addWidget(self.progress_bar)
        self.transfer_layout.addLayout(control_buttons_layout)
        
        self.log_area = QPlainTextEdit()
        self.log_area.setReadOnly(True)
        
        self.add_source_button.clicked.connect(self.open_device_browser)
        self.remove_source_button.clicked.connect(self.remove_source_folder)
        self.start_button.clicked.connect(self.start_transfer)
        self.stop_button.clicked.connect(self.stop_transfer)
        self.photo_checkbox.stateChanged.connect(self.update_filters)
        self.video_checkbox.stateChanged.connect(self.update_filters)
        self.month_selector.currentIndexChanged.connect(self.update_selected_month)
        
        self.stop_button.setEnabled(False)

    def show_context_menu(self, position):
        menu = QMenu()
        delete_action = menu.addAction("Supprimer")
        clear_action = menu.addAction("Tout effacer")
        
        action = menu.exec_(self.source_list.mapToGlobal(position))
        
        if action == delete_action:
            self.remove_source_folder()
        elif action == clear_action:
            self.source_list.clear()
            self.source_folders = []

    def populate_month_selector(self):
        self.months = [
            "Janvier", "Fevrier", "Mars", "Avril", "Mai", "Juin",
            "Juillet", "Aout", "Septembre", "Octobre", "Novembre", "Decembre"
        ]
        current_date = datetime.now()
        for i in range(12):
            date = current_date - relativedelta(months=i)
            month_name = self.months[date.month - 1]
            self.month_selector.addItem(f"{date.year} {month_name}", date)

    def update_selected_month(self, index):
        self.selected_month = self.month_selector.itemData(index)
        self.update_folder_name_input()

    def update_folder_name_input(self):
        month_name = self.months[self.selected_month.month - 1]
        self.folder_name_input.setText(f"{self.selected_month.year} {month_name}")

    def update_filters(self):
        self.filter_photos = self.photo_checkbox.isChecked()
        self.filter_videos = self.video_checkbox.isChecked()

    def change_target_folder(self):
        new_folder = QFileDialog.getExistingDirectory(self, "Sélectionner le dossier cible", self.target_folder)
        if new_folder:
            self.target_folder = new_folder
            self.target_label.setText(f"Dossier cible : {self.target_folder}")

    def open_device_browser(self):
        if self.is_android_connected():
            browser = DeviceBrowser(self)
            browser.exec_()
        else:
            self.log("Erreur : Smartphone débranché. Veuillez brancher le smartphone avant d'ajouter un dossier source.")

    def add_source_folder(self, folder):
        if folder:
            normalized_folder = folder.rstrip('/')
            if normalized_folder not in [f[0] for f in self.source_folders]:
                self.source_folders.append((normalized_folder, 'standard'))
                self.source_list.addItem(normalized_folder)

    def remove_source_folder(self):
        current_item = self.source_list.currentItem()
        if current_item:
            folder = current_item.text()
            self.source_folders = [(f, p) for f, p in self.source_folders if f != folder]
            self.source_list.takeItem(self.source_list.row(current_item))

    def start_transfer(self):
        self.transfer_thread = TransferThread(self)
        self.transfer_thread.log.connect(self.log)
        self.transfer_thread.progress.connect(self.progress_bar.setValue)
        self.transfer_thread.finished.connect(self.transfer_finished)
        self.progress_bar.setValue(0)
        self.transfer_thread.start()
        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(True)

    def stop_transfer(self):
        if hasattr(self, 'transfer_thread') and self.transfer_thread.isRunning():
            self.transfer_thread.stop_requested = True
            self.log("Arrêt du transfert demandé.")

    def transfer_finished(self):
        self.log("Le transfert des photos est terminé.")
        self.start_button.setEnabled(True)
        self.stop_button.setEnabled(False)

    def list_files(self, source_folder):
        try:
            cmd_list_files = f'{self.adb_path} shell ls "{source_folder}"'
            files = subprocess.check_output(cmd_list_files, shell=True, creationflags=subprocess.CREATE_NO_WINDOW).decode().splitlines()
            return files
        except subprocess.CalledProcessError:
            return []

    def is_selected_month(self, file, pattern):
        selected_year_month = self.selected_month.strftime('%Y%m')
        if pattern == "standard":
            return file.startswith(selected_year_month)
        elif pattern == "IMG_prefix":
            return re.match(rf'IMG_{selected_year_month}\d{{2}}_\d{{6}}_\d+', file)
        elif pattern == "VID_prefix":
            return re.match(rf'VID-{selected_year_month}\d{{2}}-WA\d+', file)
        return False

    def transfer_file(self, source_folder, file, target_folder):
        target_file_path = os.path.join(target_folder, file)
        if not os.path.exists(target_file_path):
            cmd_pull = f'{self.adb_path} pull "{source_folder}/{file}" "{target_file_path}"'
            try:
                subprocess.run(cmd_pull, shell=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                self.log(f"Transféré : {file}")
            except subprocess.CalledProcessError as e:
                self.log(f"Erreur lors du transfert de {file}: {e}")
        else:
            self.log(f"Fichier déjà existant : {file}")

class DeviceBrowser(QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Parcourir les dossiers de l'appareil")
        self.setGeometry(300, 200, 500, 400)
        self.layout = QVBoxLayout(self)

        self.tree_widget = QTreeWidget()
        self.tree_widget.setColumnCount(1)
        self.tree_widget.setHeaderLabels(["Dossiers"])
        self.tree_widget.itemDoubleClicked.connect(self.add_folder)
        self.tree_widget.itemExpanded.connect(self.on_item_expanded)
        self.layout.addWidget(self.tree_widget)

        self.populate_tree()

        self.button_close = QPushButton("Fermer")
        self.button_close.clicked.connect(self.close)
        self.layout.addWidget(self.button_close)

    def populate_tree(self):
        self.add_subfolders(self.tree_widget, "/sdcard/")

    def add_subfolders(self, parent_item, path):
        try:
            cmd_list_dirs = f'{self.parent.adb_path} shell ls -d "{path}*/"'
            subfolders = subprocess.check_output(cmd_list_dirs, shell=True).decode().splitlines()
            for folder in subfolders:
                folder_name = folder.rstrip('/').split('/')[-1]
                folder_item = QTreeWidgetItem(parent_item, [folder_name])
                folder_item.setData(0, Qt.UserRole, folder)
                folder_item.setChildIndicatorPolicy(QTreeWidgetItem.ShowIndicator)
        except subprocess.CalledProcessError:
            pass

    def on_item_expanded(self, item):
        if item.childCount() == 0:
            path = item.data(0, Qt.UserRole)
            self.add_subfolders(item, path)

    def add_folder(self, item, column):
        folder = item.data(0, Qt.UserRole)
        if folder:
            self.parent.add_source_folder(folder)
            self.close()

if __name__ == "__main__":
    app = QApplication([])
    window = PhotoTransferApp()
    window.show()
    sys.exit(app.exec_())