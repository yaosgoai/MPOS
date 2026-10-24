# -*- coding: utf-8 -*-
"""
把舊版 WebPOS 的 SQLite 資料（商品 / 備註 / 設定 / 單據版型）匯出成 gas/src/Seed.js。
GAS 第一次執行 setup() 時，若工作表是空的就會匯入這些資料。

用法：
    python scripts/export_seed.py  ..\\private_files\\taiyaki_pos.db
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "gas", "src", "Seed.js")

# 舊設定 → 新設定的對應（舊版 COM Port / Windows 印表機設定在 Android 版不需要）
SETTING_KEYS = {
    "encoding", "print_darkness", "line_spacing_percent", "print_margin_left_mm", "print_margin_top_mm",
    "print_start_x_mm", "print_start_y_mm", "barcode_max_width_percent", "always_print_barcode", "ean13_prefix",
}


def main():
    db = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "private_files", "taiyaki_pos.db")
    if not os.path.exists(db):
        print(f"找不到資料庫：{db}")
        sys.exit(1)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row

    def rows(sql):
        try:
            return [dict(r) for r in conn.execute(sql).fetchall()]
        except sqlite3.Error:
            return []

    menu = rows("SELECT id, category, name, price, sort_order, active FROM menu_items ORDER BY sort_order")
    notes = rows("SELECT id, text, sort_order, active FROM note_presets ORDER BY sort_order")
    settings_rows = rows("SELECT key, value FROM settings")
    settings = {r["key"]: r["value"] for r in settings_rows if r["key"] in SETTING_KEYS}

    layout = []
    raw_layout = {r["key"]: r["value"] for r in settings_rows}.get("receipt_layout_json", "")
    if raw_layout:
        try:
            layout = json.loads(raw_layout)
        except ValueError:
            layout = []
    layout_table = rows("SELECT * FROM receipt_layout")
    if layout_table:
        layout = layout_table

    seed = {
        "source": os.path.basename(db),
        "menu_items": menu,
        "note_presets": notes,
        "settings": settings,
        "receipt_layout": layout,
    }
    content = (
        "/**\n * 由 scripts/export_seed.py 自動產生：舊版 WebPOS 資料（只在試算表為空時匯入）\n */\n"
        "var SEED_DATA = " + json.dumps(seed, ensure_ascii=False, indent=2) + ";\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"已輸出 {OUT}：商品 {len(menu)}、備註 {len(notes)}、設定 {len(settings)}、版型 {len(layout)}")


if __name__ == "__main__":
    main()
