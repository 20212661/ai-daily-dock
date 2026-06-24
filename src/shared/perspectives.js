/* ============================================================
   perspectives.js — 三视角头脑风暴的「唯一真值」
   ------------------------------------------------------------
   主进程（aiService.js 的 brainstorm）和 agent-server（pi-planner.js
   的 runPerspectives）原本各自硬编码了一份几乎相同的视角定义，
   容易在演进时产生分叉。本模块集中定义，两端都从这里取。

   require 方式（两端都基于项目根目录解析）：
     主进程：  require('./src/shared/perspectives')
     agent-server： require('../src/shared/perspectives')

   每个视角字段：
     id    —— 稳定标识（前端/日志引用）
     name  —— 中文展示名
     system(maxWords) —— 返回该视角的 system prompt，maxWords 控制字数上限
   ============================================================ */
module.exports = {
  // 默认字数上限（主进程 brainstorm 历史用 150，agent-server 用 120）
  DEFAULT_MAX_WORDS: 150,
  PERSPECTIVES: [
    {
      id: 'architect',
      name: '架构师视角',
      system: function (maxWords) {
        var w = maxWords || 150;
        return '你是一位严谨的架构师。对于用户给的任务，你从以下角度分析：\n' +
          '1. 这个任务的核心目标和成功标准是什么？\n' +
          '2. 有哪些关键技术约束或依赖？\n' +
          '3. 最小可行路径是什么（以最简单的方式完成）？\n' +
          '4. 有哪些潜在风险和陷阱？\n' +
          '请简洁地分析，总共不超过 ' + w + ' 字。';
      }
    },
    {
      id: 'challenger',
      name: '质疑者视角',
      system: function (maxWords) {
        var w = maxWords || 150;
        return '你是一位吹毛求疵的质疑者。对于用户给的任务，你要：\n' +
          '1. 用苏格拉底式追问，找出任务描述中模糊或想当然的地方\n' +
          '2. 挑战隐含假设——“你确定这个前提成立吗？”\n' +
          '3. 指出用户可能没想到的边界情况\n' +
          '4. 提出反面：“如果不做这个任务会怎样？”\n' +
          '请直接列出你的追问和质疑，总共不超过 ' + w + ' 字。不要客气。';
      }
    },
    {
      id: 'practitioner',
      name: '实践者视角',
      system: function (maxWords) {
        var w = maxWords || 150;
        return '你是一位务实的实践者。对于用户给的任务，你从以下角度分析：\n' +
          '1. 如果现在只有 30 分钟，你会怎么做？\n' +
          '2. 哪些是真正高价值的动作，哪些是在忙碌但无效？\n' +
          '3. 有没有现成的工具/模板/参考可以复用？\n' +
          '4. 给出 3 个你认为最值得做的具体步骤建议。\n' +
          '请用简洁的要点回答，总共不超过 ' + w + ' 字。';
      }
    }
  ],

  // 便捷：生成可直接喂给 AI 的视角列表（system 已用 maxWords 实例化）
  build: function (maxWords) {
    return this.PERSPECTIVES.map(function (p) {
      return { id: p.id, name: p.name, system: p.system(maxWords) };
    });
  }
};
