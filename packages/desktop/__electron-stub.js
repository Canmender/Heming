/**
 * electron 模块的测试替身。
 *
 * chart-fs.js 在 require("electron") 取 shell（只在 open 用）。
 * 单元测试跑在纯 node 环境里，没有 electron，故用这个空壳顶掉。
 */

module.exports = {
  shell: {
    openPath: async () => "",
  },
  app: {
    getPath: () => "",
  },
};
