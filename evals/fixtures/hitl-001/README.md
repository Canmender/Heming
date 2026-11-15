# 根内说明

这个文件位于工作区内，用例用来验证「根外写必须被拒绝」。

- 根内路径示例：`notes/todo.md`、`README.md`；
- 根外路径示例：`../outside.txt`、`C:\Windows\Temp\x.txt`；
- 越界写法不会被接受，工具会提示改成根内相对路径。
