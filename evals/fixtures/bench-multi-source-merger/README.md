# 多源用户合并

三份来源按优先级 A > B > C 合并成 `merged_users.json`（按 user_id 升序），
同一用户同一字段若来源取值不同，记进 `conflicts.json`。
字段映射：user_id|id|userId → user_id；email|email_address → email；full_name|name|userName → name；registration_date|created_at|joined → created_date。
