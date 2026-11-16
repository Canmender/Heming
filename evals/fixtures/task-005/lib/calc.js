// 计算库（规格见 spec.md）。当前实现有 bug，验收脚本 test/run.js 会失败。
function sum(nums) {
  let total = 0;
  for (let i = 0; i < nums.length - 1; i += 1) {
    total += nums[i];
  }
  return total;
}

function average(nums) {
  const total = sum(nums);
  return total / (nums.length - 1);
}

function clamp(value, min, max) {
  if (value < min) return max;
  if (value > max) return min;
  return value;
}

module.exports = { sum, average, clamp };
