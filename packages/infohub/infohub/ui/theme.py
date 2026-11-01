QSS = """
QMainWindow, QWidget { background: #ffffff; color: #1f2329; }
QFrame#topbar { background: #fbfbfc; border-bottom: 1px solid #e6e8eb; }
QLabel#brand { color: #2f6fed; font-size: 15px; font-weight: 700; }
QLabel#sectionTitle { color: #8b929c; font-size: 11px; font-weight: 600; }
QLabel#convTitle { font-size: 17px; font-weight: 700; color: #1f2329; }
QLabel#convMeta { color: #8b929c; font-size: 11px; }
QLineEdit { border: 1px solid #dcdfe4; border-radius: 7px; padding: 7px 11px; background: #ffffff; selection-background-color: #cfe0ff; }
QLineEdit:focus { border-color: #2f6fed; }
QPushButton { border: 1px solid #dcdfe4; background: #ffffff; border-radius: 7px; padding: 7px 13px; }
QPushButton:hover { background: #f5f7fa; }
QPushButton:pressed { background: #eef1f5; }
QPushButton:disabled { color: #b6bcc4; background: #fafbfc; }
QPushButton:checked { background: #eaf1ff; border-color: #2f6fed; color: #2f6fed; font-weight: 600; }
QPushButton#primary { background: #2f6fed; border: none; color: #ffffff; font-weight: 600; }
QPushButton#primary:hover { background: #2560d4; }
QPushButton#primary:disabled { background: #a9c0f5; }
QComboBox { border: 1px solid #dcdfe4; border-radius: 7px; padding: 6px 10px; background: #ffffff; min-width: 76px; }
QComboBox::drop-down { border: none; width: 18px; }
QListWidget { border: none; background: #ffffff; outline: none; }
QListWidget::item { border-bottom: 1px solid #f1f2f4; }
QListWidget::item:selected { background: #eaf1ff; }
QListWidget::item:hover { background: #f6f8fb; }
QTextBrowser { border: none; background: #ffffff; }
QStatusBar { background: #fbfbfc; border-top: 1px solid #e6e8eb; }
QStatusBar QLabel { color: #7a828e; font-size: 11px; }
QProgressBar { border: none; background: #eceff3; border-radius: 3px; max-height: 6px; min-height: 6px; }
QProgressBar::chunk { background: #2f6fed; border-radius: 3px; }
QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #d5d9df; border-radius: 5px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #b9c0c9; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
QSpinBox { border: 1px solid #dcdfe4; border-radius: 7px; padding: 5px 8px; background: #ffffff; }
QCheckBox { spacing: 7px; }
QLabel#hint { color: #8b929c; font-size: 11px; }
QTabWidget::pane { border: 1px solid #e6e8eb; border-radius: 8px; top: -1px; }
QTabBar::tab { background: transparent; color: #7a828e; padding: 8px 16px; border-bottom: 2px solid transparent; }
QTabBar::tab:selected { color: #2f6fed; border-bottom: 2px solid #2f6fed; font-weight: 600; }
QGroupBox { border: 1px solid #e6e8eb; border-radius: 8px; margin-top: 14px; padding: 12px 10px 8px 10px; }
QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #7a828e; font-size: 11px; font-weight: 600; }
"""
