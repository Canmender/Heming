/* 生成 Terminal-Bench 2 风格的真实任务夹具（d.179）。
 *
 * 来源：harbor-framework/terminal-bench-2 的公开任务说明（log-summary-date-ranges /
 * regex-log / fix-git / multi-source-data-merger / git-leak-recovery），按我们无网络、
 * 只有 node/python/git 的环境做最小改动（parquet → json），题目语义不变。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = "evals/fixtures";
const TMP = ".tmp";
fs.mkdirSync(TMP, { recursive: true });

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function sh(cwd, cmd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------- 1) log summary
{
  const dir = `${ROOT}/bench-log-summary`;
  rm(dir);
  // 参考日 2025-08-12；覆盖 today / 近 7 天 / 近 30 天 / 本月 / 更早
  const files = {
    "2025-08-12_app.log": [
      "2025-08-12T09:01:02Z ERROR db timeout",
      "2025-08-12T09:02:03Z WARNING retry 1",
      "2025-08-12T09:03:04Z INFO request ok",
      "2025-08-12T10:00:00Z ERROR db timeout",
    ],
    "2025-08-12_worker.log": ["2025-08-12T11:00:00Z WARNING queue depth 12", "2025-08-12T11:01:00Z INFO job done"],
    "2025-08-11_app.log": [
      "2025-08-11T09:00:00Z ERROR cache miss",
      "2025-08-11T09:10:00Z INFO request ok",
      "2025-08-11T09:20:00Z WARNING slow query",
    ],
    "2025-08-06_app.log": ["2025-08-06T08:00:00Z ERROR disk full", "2025-08-06T08:30:00Z INFO cleaned"],
    "2025-08-05_app.log": ["2025-08-05T08:00:00Z ERROR early month", "2025-08-05T08:30:00Z WARNING early"],
    "2025-08-01_worker.log": ["2025-08-01T07:00:00Z ERROR month start", "2025-08-01T07:30:00Z INFO start"],
    "2025-07-20_app.log": ["2025-07-20T06:00:00Z ERROR last month", "2025-07-20T06:30:00Z INFO last month"],
    "2025-07-01_app.log": ["2025-07-01T05:00:00Z ERROR old", "2025-07-01T05:30:00Z WARNING old"],
  };
  for (const [name, lines] of Object.entries(files)) write(`${dir}/logs/${name}`, `${lines.join("\n")}\n`);
  const ref = "2025-08-12";
  const day = (d) => new Date(`${d}T00:00:00Z`).getTime() / 86400000;
  const rows = [];
  for (const [name, lines] of Object.entries(files)) {
    for (const line of lines) {
      const m = /^(\d{4}-\d{2}-\d{2})T[^ ]+ (ERROR|WARNING|INFO) /.exec(line);
      rows.push({ date: m[1], severity: m[2] });
    }
  }
  const periods = {
    today: rows.filter((r) => r.date === ref),
    last_7_days: rows.filter((r) => day(ref) - day(r.date) < 7),
    last_30_days: rows.filter((r) => day(ref) - day(r.date) < 30),
    month_to_date: rows.filter((r) => r.date.slice(0, 7) === ref.slice(0, 7)),
    total: rows,
  };
  const out = ["period,severity,count"];
  for (const [period, list] of Object.entries(periods)) {
    for (const sev of ["ERROR", "WARNING", "INFO"]) {
      out.push(`${period},${sev},${list.filter((r) => r.severity === sev).length}`);
    }
  }
  write(`${TMP}/bench-log-expected.csv`, `${out.join("\n")}\n`);
  console.log("[log-summary] 15 行期望值");
}

// ---------------------------------------------------------------- 2) regex log
{
  const dir = `${ROOT}/bench-regex-log`;
  rm(dir);
  const lines = [
    "2025-08-01 10:00:00 INFO client 10.1.2.3 connected",
    "2025-08-02 11:00:00 INFO no address here, date 2025-08-02",
    "2025-08-03 12:00:00 WARN user 192.168.1.9 then 2025-07-04 and 2025-08-05",
    "date 2025-08-06 then client 172.16.0.1 says 2025-08-07",
    "2025-02-30 09:00:00 ERROR impossible day client 8.8.8.8",
    "2025-08-08 13:00:00 INFO x2025-08-09y client 1.2.3.4",
    "2025-08-10 14:00:00 INFO client 256.1.1.1 invalid ip",
    "2025-08-11 15:00:00 INFO client 203.0.113.7",
    "2025-08-12 16:00:00 INFO client 198.51.100.4 last date 2025-08-12",
  ];
  write(`${dir}/log.txt`, `${lines.join("\n")}\n`);
  write(
    `${dir}/README.md`,
    "# 正则任务\n\n写 `regex.txt`：用它匹配「同一行里有合法 IPv4 时」的**第一个** `YYYY-MM-DD` 日期。\n" +
      "判定方式：`re.findall(pattern, open('log.txt').read(), re.MULTILINE)` 的输出必须等于期望列表。\n" +
      "约束：日期必须合法（月份 01-12、日按当月天数，2 月最多 29）、IPv4 四段 0-255 且无前导零、\n" +
      "日期前后不能紧挨字母数字、IPv4 之后才出现的日期不算。\n",
  );
  // 期望：逐行取「含合法 IPv4 的行」里、IP 之前的第一个合法日期
  const expected = ["2025-08-03", "2025-08-06", "2025-08-12"];
  write(`${TMP}/bench-regex-expected.json`, JSON.stringify(expected));
  console.log("[regex-log] 期望", expected.join(","));
}

// ---------------------------------------------------------------- 3) multi-source merger
{
  const dir = `${ROOT}/bench-multi-source-merger`;
  rm(dir);
  // A：最高优先（json）；B：同名用户带旧邮箱（csv）；C：最低优先（json，替代 parquet）
  write(
    `${dir}/data/source_a.json`,
    JSON.stringify(
      [
        { user_id: "u1", full_name: "Ada Lovelace", email: "ada@a.example", registration_date: "2024-01-05" },
        { user_id: "u2", full_name: "Grace Hopper", email: "grace@a.example", registration_date: "2024-02-11" },
      ],
      null,
      2,
    ),
  );
  write(
    `${dir}/data/source_b.csv`,
    [
      "id,email_address,name,created_at",
      "u1,ada.old@b.example,Ada L.,2023-12-31",
      "u3,linus@b.example,Linus T.,2024-03-02",
    ].join("\n") + "\n",
  );
  write(
    `${dir}/data/source_c.json`,
    JSON.stringify(
      [
        { userId: "u2", email: "grace@c.example", userName: "G. Hopper", joined: "2024-02-09" },
        { userId: "u4", email: "ken@c.example", userName: "Ken T.", joined: "2024-04-04" },
      ],
      null,
      2,
    ),
  );
  write(
    `${dir}/README.md`,
    "# 多源用户合并\n\n三份来源按优先级 A > B > C 合并成 `merged_users.json`（按 user_id 升序），\n" +
      "同一用户同一字段若来源取值不同，记进 `conflicts.json`。\n" +
      "字段映射：user_id|id|userId → user_id；email|email_address → email；full_name|name|userName → name；registration_date|created_at|joined → created_date。\n",
  );
  write(
    `${TMP}/bench-merge-expected.json`,
    JSON.stringify(
      [
        { user_id: "u1", email: "ada@a.example", name: "Ada Lovelace", created_date: "2024-01-05" },
        { user_id: "u2", email: "grace@a.example", name: "Grace Hopper", created_date: "2024-02-11" },
        { user_id: "u3", email: "linus@b.example", name: "Linus T.", created_date: "2024-03-02" },
        { user_id: "u4", email: "ken@c.example", name: "Ken T.", created_date: "2024-04-04" },
      ],
      null,
      2,
    ),
  );
  console.log("[multi-source] 期望 4 行合并");
}

// ---------------------------------------------------------------- 4) fix-git
{
  const dir = `${ROOT}/bench-fix-git`;
  rm(dir);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git init -q -b master");
  sh(dir, 'git config user.email "dev@example.com"');
  sh(dir, 'git config user.name "Dev"');
  write(`${dir}/site/index.html`, "<h1>My Site</h1>\n<p>v1</p>\n");
  sh(dir, "git add -A");
  sh(dir, 'git commit -q -m "site v1"');
  sh(dir, "git checkout -q -b feature");
  write(`${dir}/site/index.html`, "<h1>My Site</h1>\n<p>v2 with hero</p>\n");
  write(`${dir}/site/about.html`, "<h1>About me</h1>\n<p>I build things.</p>\n");
  write(`${dir}/site/style.css`, "body { margin: 0; }\n");
  sh(dir, "git add -A");
  sh(dir, 'git commit -q -m "add hero and about page"');
  sh(dir, "git checkout -q master");
  sh(dir, "git branch -D feature");
  console.log("[fix-git] 仓库已建（feature 提交成悬空对象）");
}

// ---------------------------------------------------------------- 5) git leak recovery
{
  const dir = `${ROOT}/bench-git-leak-recovery`;
  rm(dir);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git init -q -b master");
  sh(dir, 'git config user.email "dev@example.com"');
  sh(dir, 'git config user.name "Dev"');
  write(`${dir}/app.js`, "console.log('app');\n");
  sh(dir, "git add -A");
  sh(dir, 'git commit -q -m "init"');
  // 曾经提交过密钥，随后被 amend 改写掉（真机上只能从悬空对象/reflog 找回）
  write(`${dir}/.env`, "API_KEY=secret[9f8e7d]\nDEBUG=1\n");
  sh(dir, "git add -A");
  sh(dir, 'git commit -q -m "add env"');
  write(`${dir}/.env`, "API_KEY=\nDEBUG=1\n");
  sh(dir, "git add -A");
  sh(dir, "git commit -q --amend -m \"add env\"");
  sh(dir, "git reflog expire --expire=never --all");
  write(`${dir}/README.md`, "# app\n\n曾经提交过一枚密钥，后来历史被改写了。\n");
  sh(dir, "git add -A");
  sh(dir, 'git commit -q -m "readme"');
  write(`${TMP}/bench-leak-secret.txt`, "secret[9f8e7d]");
  console.log("[git-leak] 仓库已建（密钥在悬空对象里）");
}

console.log("done");
