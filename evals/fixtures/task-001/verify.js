// 校验脚本：由用例中的模型自己调用（node verify.js），模拟「改完自己验证」这一步。
const { readFileSync } = require("node:fs");

function lines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const source = lines("numbers.txt").map((line) => Number(line));
const expected = [...new Set(source)].sort((a, b) => a - b).map(String);

let actual;
try {
  actual = lines("sorted.txt");
} catch {
  console.log("失败：还没有 sorted.txt");
  process.exit(1);
}

if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
  console.log(`失败：期望 ${expected.join(",")}，实际 ${actual.join(",")}`);
  process.exit(1);
}

console.log("全部通过");
