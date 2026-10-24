/**
 * 由 scripts/export_seed.py 自動產生：舊版 WebPOS 資料（只在試算表為空時匯入）
 */
var SEED_DATA = {
  "source": "taiyaki_pos.db",
  "menu_items": [
    {
      "id": "original",
      "category": "鯛魚燒口味",
      "name": "原味（無餡料）",
      "price": 35,
      "sort_order": 10,
      "active": 1
    },
    {
      "id": "custard",
      "category": "鯛魚燒口味",
      "name": "卡士達",
      "price": 45,
      "sort_order": 20,
      "active": 1
    },
    {
      "id": "cheese",
      "category": "鯛魚燒口味",
      "name": "起司",
      "price": 45,
      "sort_order": 30,
      "active": 1
    },
    {
      "id": "milk_crisp",
      "category": "鯛魚燒口味",
      "name": "奶酥",
      "price": 45,
      "sort_order": 40,
      "active": 1
    },
    {
      "id": "tuna_corn_cheese",
      "category": "鯛魚燒口味",
      "name": "鮪魚玉米起司（鹹）",
      "price": 60,
      "sort_order": 50,
      "active": 1
    },
    {
      "id": "white_sauce_sausage",
      "category": "鯛魚燒口味",
      "name": "白醬德式香腸（鹹）",
      "price": 60,
      "sort_order": 60,
      "active": 1
    },
    {
      "id": "agar_jelly",
      "category": "甜點",
      "name": "洋菜凍",
      "price": 25,
      "sort_order": 70,
      "active": 1
    },
    {
      "id": "tea_jelly",
      "category": "甜點",
      "name": "茶凍",
      "price": 30,
      "sort_order": 80,
      "active": 1
    }
  ],
  "note_presets": [
    {
      "id": 1,
      "text": "先做",
      "sort_order": 10,
      "active": 1
    },
    {
      "id": 2,
      "text": "分開裝",
      "sort_order": 20,
      "active": 1
    },
    {
      "id": 3,
      "text": "一起裝",
      "sort_order": 30,
      "active": 1
    },
    {
      "id": 4,
      "text": "客人現場等",
      "sort_order": 40,
      "active": 1
    },
    {
      "id": 5,
      "text": "電話預訂",
      "sort_order": 50,
      "active": 1
    },
    {
      "id": 6,
      "text": "少量紙袋",
      "sort_order": 60,
      "active": 1
    },
    {
      "id": 7,
      "text": "不要壓到",
      "sort_order": 70,
      "active": 1
    }
  ],
  "settings": {
    "encoding": "cp950",
    "print_darkness": "extra_dark",
    "line_spacing_percent": "100",
    "always_print_barcode": "1",
    "barcode_max_width_percent": "92"
  },
  "receipt_layout": [
    {
      "role": "barcode",
      "title": "單號條碼",
      "show": 1,
      "font_pt": 8,
      "weight": 900,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 4
    },
    {
      "role": "shop_name",
      "title": "店名",
      "show": 1,
      "font_pt": 12,
      "weight": 900,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 2
    },
    {
      "role": "separator",
      "title": "分隔線",
      "show": 1,
      "font_pt": 7,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "order_no",
      "title": "單號",
      "show": 1,
      "font_pt": 8,
      "weight": 700,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "time",
      "title": "時間",
      "show": 1,
      "font_pt": 11,
      "weight": 900,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 1
    },
    {
      "role": "item_header",
      "title": "品項標題",
      "show": 1,
      "font_pt": 14,
      "weight": 700,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "item",
      "title": "品項明細",
      "show": 1,
      "font_pt": 14,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "total",
      "title": "合計",
      "show": 1,
      "font_pt": 14,
      "weight": 900,
      "align": "left",
      "x_offset": 0,
      "space_before": 1,
      "space_after": 1
    },
    {
      "role": "payment",
      "title": "付款/收款/找零",
      "show": 1,
      "font_pt": 12,
      "weight": 700,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "note",
      "title": "備註",
      "show": 1,
      "font_pt": 14,
      "weight": 700,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 1
    },
    {
      "role": "footer_msg",
      "title": "提示語",
      "show": 1,
      "font_pt": 10,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 1,
      "space_after": 0
    },
    {
      "role": "address",
      "title": "地址",
      "show": 1,
      "font_pt": 8,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "phone",
      "title": "電話",
      "show": 1,
      "font_pt": 10,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    },
    {
      "role": "blank",
      "title": "空白列",
      "show": 1,
      "font_pt": 7,
      "weight": 400,
      "align": "left",
      "x_offset": 0,
      "space_before": 0,
      "space_after": 0
    }
  ]
};
