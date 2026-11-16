// 验收脚本：改 lib/calc.js 让这里全部通过。不要修改本文件。
const { sum, average, clamp } = require("../lib/calc");

// 按函数分组：一个函数的所有断言都通过，才算这个函数通过（共 3 个函数）。
const groups = {
  sum: [
    ["sum([1,2,3]) 应为 6", () => sum([1, 2, 3]) === 6],
    ["sum([]) 应为 0", () => sum([]) === 0],
  ],
  average: [
    ["average([2,4,6]) 应为 4", () => average([2, 4, 6]) === 4],
    ["average([]) 应为 0", () => average([]) === 0],
  ],
  clamp: [
    ["clamp(-5,0,10) 应为 0", () => clamp(-5, 0, 10) === 0],
    ["clamp(15,0,10) 应为 10", () => clamp(15, 0, 10) === 10],
    ["clamp(5,0,10) 应为 5", () => clamp(5, 0, 10) === 5],
  ],
};

const failed = [];
let passedGroups = 0;
for (const [fn, cases] of Object.entries(groups)) {
  const failures = cases.filter(([, run]) => {
    try {
      return !run();
    } catch {
      return true;
    }
  });
  if (failures.length === 0) passedGroups += 1;
  for (const [name] of failures) failed.push(`${fn}：${name}`);
}

if (failed.length > 0) {
  for (const line of failed) console.log(`失败：${line}`);
  console.log(`未通过（${passedGroups}/${Object.keys(groups).length}）`);
  process.exit(1);
}

console.log(`全部通过（${passedGroups}/${Object.keys(groups).length}）`);
