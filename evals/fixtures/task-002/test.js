const { sum } = require("./calc.js");

const got = sum([1, 2, 3]);
if (got === 6) {
  console.log("全部通过");
  process.exit(0);
}
console.log(`失败：sum([1,2,3]) = ${got}`);
process.exit(1);
