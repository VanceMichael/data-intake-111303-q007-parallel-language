# 来源与接收约定

GET 种子页取得 lang/point/revision/alternates/segments；该 JSON 是原站页面适配层的既有输出，并非现成对应关系。双向互链且 point 一致才能确认页级关系，segment.anchor 在该观察点内比较；sourceRevision 小于源段落 revision 视为 translation-lag。源侧独有段落 source-new；弱线索列 uncertain，格式 源路径->目标路径。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 双向互链但修订滞后

业务输入：
```json
{
  "seeds": [
    "/zh/a"
  ]
}
```
结果必须包含：
```json
{
  "points": {
    "lake": {
      "s1": "translation-lag"
    }
  }
}
```

### 单向同名链接不能强配

业务输入：
```json
{
  "seeds": [
    "/zh/a"
  ]
}
```
结果必须包含：
```json
{
  "uncertain": [
    "/zh/a->/ru/a"
  ]
}
```

### 源文新增不是译文删除

业务输入：
```json
{
  "seeds": [
    "/zh/a"
  ]
}
```
结果必须包含：
```json
{
  "points": {
    "p1": {
      "new": "source-new"
    }
  }
}
```
