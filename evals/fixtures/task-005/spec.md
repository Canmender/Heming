# 计算库规格

`lib/calc.js` 导出三个函数：

- `sum(nums)`：返回数组所有元素之和；空数组返回 `0`。
- `average(nums)`：返回平均数；空数组返回 `0`（不是 `NaN`）。
- `clamp(value, min, max)`：小于 `min` 返回 `min`，大于 `max` 返回 `max`，其余原样返回。

验收标准：`node test/run.js` 必须打印「全部通过（3/3）」并以退出码 0 结束。

注意：`test/run.js` 是验收脚本，不要修改它——要改的是 `lib/calc.js`。
