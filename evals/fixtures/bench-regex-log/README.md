# 正则任务

写 `regex.txt`：用它匹配「同一行里有合法 IPv4 时」的**第一个** `YYYY-MM-DD` 日期。
判定方式：`re.findall(pattern, open('log.txt').read(), re.MULTILINE)` 的输出必须等于期望列表。
约束：日期必须合法（月份 01-12、日按当月天数，2 月最多 29）、IPv4 四段 0-255 且无前导零、
日期前后不能紧挨字母数字、IPv4 之后才出现的日期不算。
