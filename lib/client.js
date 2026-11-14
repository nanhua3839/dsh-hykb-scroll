/**
 * dsh-hykb-scroll —— 客户端半边：DSH「设置」里的 **快爆** section
 *
 * 设计原则（v4，对齐 DSH / Harmony 原生视觉）：
 *   1. 视觉只用平台设计变量（--dsw-alias-*）与原生原语的尺寸：按钮胶囊 28/36、Pill 24、
 *      输入框 32 圆角 8、hint 12/18、tooltip 13/20。不自己造色值。
 *   2. 说明文字一律收进 tooltip。行内只留标签 + ⓘ，界面不再堆小字。
 *   2b. 登录两条路并列成 tab：扫码 / 手动填 Cookie。扫码失败或已有现成登录态时不用绕路。
 *   3. 顶部四张模式卡一次点掉所有开关；卡片序号 1→8 就是上手顺序。
 *   4. 关掉的卡只留一行摘要，不占版面。
 *   5. 没有保存按钮：改哪个就存哪个，去抖 400ms 后整份提交，页头只留一行保存状态。
 *
 * 数据流没变：section ⇄ /dsh-hykb/api/* ⇄ ~/.dsh/hykb-scroll.config.json（与 tools/hykb.mjs 同一份）
 * 自动保存同样提交整份配置，未显示的字段不会被抹掉。
 */
window.__ModuleLoader__.load({
  id: "dsh-hykb-scroll",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState, useRef } = React;

    const API = "/dsh-hykb/api";
    const CSS_TAG = "dsh-hykb-scroll/section.css";

    /* 只用平台上真实存在的 token。多写一个不存在的变量名 = 该项样式静默失效。 */
    const CSS = [
      /* ── 容器 ── */
      ".hks{max-width:720px;container-type:inline-size;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;-webkit-font-smoothing:antialiased}",
      ".hks *,.hks *::before,.hks *::after{box-sizing:border-box}",

      /* ── 页头 ── */
      ".hks-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0 10px}",
      ".hks-ht{flex:1;min-width:0}",
      ".hks-title{margin:0;font-size:15px;line-height:22px;font-weight:600;letter-spacing:.2px}",
      ".hks-sub{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── 状态 pill 行（原生 Pill 规格：h24 r12 12/18）── */
      ".hks-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:8px}",
      ".hks-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}",
      ".hks-pill>b{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".hks-dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}",
      ".hks-dot[data-s=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".hks-dot[data-s=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".hks-dot[data-s=bad]{background:var(--dsw-alias-state-error-primary)}",

      /* ── 模式卡 ── */
      ".hks-modes{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:2px 0 12px}",
      ".hks-mode{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:background .12s,border-color .12s}",
      ".hks-mode>b{font-size:12.5px;line-height:18px;font-weight:600}",
      ".hks-mode>span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".hks-mode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-mode:disabled{cursor:not-allowed;opacity:.5}",
      ".hks-mode[data-on='1']{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-mode[data-k='test']{border-style:dashed}",
      ".hks-mode[data-k='test'][data-on='1']{border-color:var(--dsw-alias-state-warn-primary)}",
      /* 测试模式提示条 */
      ".hks-testbar{margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px dashed var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".hks-testbar>b{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
      /* 必须先看见的提醒：一整行，不折进 tooltip */
      ".hks-warn{display:flex;flex-direction:column;gap:3px;margin:6px 0 10px;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:transparent}",
      ".hks-warn>b{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-state-warn-primary)}",
      ".hks-warn>span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      /* 保存被拒：红色实边，比警告条更重 */
      ".hks-blocked{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);background:transparent}",
      ".hks-blocked-h{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".hks-blocked-h>b{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-state-error-primary)}",
      ".hks-blocked-b{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-line}",
      ".hks-blocked>.hks-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      /* 被拒的那一行描红：只描红，不写命中词 */
      ".hks-row[data-bad='1']>.hks-l>.hks-lbl,.hks-row[data-bad='1']>.hks-l>.hks-lbl{color:var(--dsw-alias-state-error-primary)}",
      ".hks-row[data-bad='1'] .hks-in,.hks-row[data-bad='1'] .hks-ta{border-color:var(--dsw-alias-state-error-primary)}",
      /* 中转站一条 */
      ".hks-relay{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
      ".hks-relay-h{display:flex;align-items:center;gap:8px;min-width:0}",
      ".hks-relay-h>b{font-size:12.5px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}",
      ".hks-relay-h>.hks-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hks-relay-g{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);gap:6px}",
      /* min-width:0 是必须的：grid 子项默认 min-width:auto，input 的固有宽度会把格子撑破并横向溢出 */
      ".hks-relay-g>input{min-width:0;width:100%}",
      "@container (max-width:520px){.hks-relay-g{grid-template-columns:minmax(0,1fr)}}",
      /* 运行日志 / 自检 */
      ".hks-acts{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;margin:8px 0 0}",
      ".hks-hist{max-height:260px;overflow:auto;margin:8px 0 0}",
      ".hks-act{display:grid;grid-template-columns:64px 72px minmax(0,1fr);gap:8px;align-items:start;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".hks-act>time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".hks-act>b{font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".hks-act>span{overflow-wrap:anywhere}",
      ".hks-act[data-l='fail']>span{color:var(--dsw-alias-state-error-primary)}",
      ".hks-act[data-l='warn']>span{color:var(--dsw-alias-state-warn-primary)}",
      ".hks-act[data-l='pass']>span{color:var(--dsw-alias-state-success-primary)}",
      ".hks-steps{display:flex;flex-direction:column;gap:4px;margin:8px 0 0}",
      ".hks-step{display:grid;grid-template-columns:44px 150px minmax(0,1fr);gap:8px;align-items:start;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".hks-step>b{font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".hks-step>span{overflow-wrap:anywhere}",

      /* ── 卡片 ── */
      ".hks-card{padding:14px 16px 16px;border:none;border-radius:12px;background:var(--dsw-alias-interactive-bg-active)}",
      ".hks-chead{display:flex;align-items:center;gap:8px;min-height:24px}",
      ".hks-no{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;font-weight:600}",
      ".hks-ct{flex:1;min-width:0}",
      ".hks-ct>h4{margin:0;font-size:13px;line-height:20px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".hks-ct>p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".hks-cbody{padding:6px 0 0}",
      ".hks-card[data-off='1']>.hks-cbody{display:none}",
      ".hks-card[data-closed='1']>.hks-cbody{display:none}",
      ".hks-chev{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;margin-left:2px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s,color .12s}",
      ".hks-chev::before{content:'▸';font-size:11px;line-height:1;transition:transform .12s}",
      ".hks-chev[data-open='1']::before{transform:rotate(90deg)}",
      ".hks-chev:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".hks-chev:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      ".hks-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font-size:11px;line-height:18px;font-weight:500;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}",
      ".hks-badge[data-s=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".hks-badge[data-s=warn]{color:var(--dsw-alias-state-warn-primary)}",

      /* ── 行：左标签右控件 ── */
      ".hks-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,200px);column-gap:16px;align-items:center;padding:8px 0;min-height:38px}",
      ".hks-row--block{grid-template-columns:minmax(0,1fr);row-gap:6px;align-items:stretch}",
      ".hks-l{min-width:0;display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
      ".hks-lbl{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".hks-c{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}",
      ".hks-c>*{width:100%}",
      ".hks-c>.hks-sw{width:36px}",".hks-c>.hks-btn{width:auto}",
      ".hks-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── tooltip：完全复刻平台 bubble 规格 ── */
      ".hks-tipwrap,.hks-tipslot{display:contents}",
      ".hks-i{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:10px;line-height:1;font-weight:600;cursor:help;user-select:none;vertical-align:middle}",
      ".hks-i:hover,.hks-i:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);outline:none}",
      ".hks-bubble{position:fixed;z-index:100;width:max-content;max-width:min(320px,50vw);padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.16)}",
      ".hks-bubble[data-side=right]{transform:translateY(-50%)}",
      ".hks-bubble[data-side=bottom]{transform:translateX(-50%)}",
      ".hks-bubble[data-side=top]{transform:translate(-50%,-100%)}",

      /* ── 输入：原生 input wrapper 规格 h32 r8 ── */
      ".hks-in{display:block;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);outline:none;transition:border-color .12s}",
      ".hks-in:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".hks-in::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".hks-in:disabled{opacity:.5;cursor:not-allowed}",
      ".hks-ta{display:block;width:100%;min-height:68px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:inherit;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);outline:none;resize:vertical;transition:border-color .12s}",
      ".hks-ta:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".hks-ta::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".hks-ta:disabled{opacity:.5;cursor:not-allowed}",

      /* ── 搜索：页头下面一行，输入即筛 ── */
      ".hks-find{position:relative;padding:0 0 8px}",
      ".hks-find>input{padding-left:28px}",
      ".hks-find-ic{position:absolute;left:10px;top:9px;width:13px;height:13px;color:var(--dsw-alias-label-tertiary);pointer-events:none}",
      ".hks-find-ic::before{content:'';position:absolute;left:0;top:0;width:8px;height:8px;border:1.5px solid currentColor;border-radius:50%}",
      ".hks-find-ic::after{content:'';position:absolute;left:8px;top:9px;width:5px;height:1.5px;border-radius:1px;background:currentColor;transform:rotate(45deg);transform-origin:left center}",
      ".hks-res{position:absolute;z-index:20;left:0;right:0;top:34px;display:flex;flex-direction:column;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:0 8px 24px rgba(0,0,0,.12)}",
      ".hks-res>button{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".hks-res>button:hover,.hks-res>button:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}",
      ".hks-res>button>span{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".hks-res>p{margin:0;padding:6px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      /* 定位后那一行闪 1.5 秒：最亮时也不全透明，截图不会拍空 */
      ".hks-hit{animation:hks-hit 1.5s ease-in-out}",
      "@keyframes hks-hit{0%{background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 0 0 0 2px var(--dsw-alias-label-tertiary)}45%{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}70%{background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 0 0 0 2px var(--dsw-alias-label-tertiary)}100%{background:transparent;box-shadow:inset 0 0 0 2px transparent}}",

      /* ── 开关 36x20 ── */
      ".hks-sw{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .16s}",
      ".hks-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .16s}",
      ".hks-sw[data-on='1']{background:var(--dsw-alias-state-success-primary)}",
      ".hks-sw[data-on='1']::after{transform:translateX(16px)}",
      ".hks-sw:disabled{cursor:not-allowed;opacity:.4}",
      ".hks-sw:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",

      /* ── 分段切换 ── */
      ".hks-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-seg>button{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:1;height:26px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);white-space:nowrap;min-width:max-content;font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s,color .12s}",
      ".hks-seg>button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
      ".hks-seg>button[data-on='1']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}",
      ".hks-seg>button:disabled{cursor:not-allowed;opacity:.5}",
      ".hks-tabs{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 8px}",

      /* ── 标签点选（个性化题材）：一排可选胶囊，选中即实心 ── */
      ".hks-tags{display:flex;flex-wrap:wrap;gap:6px}",
      ".hks-tag{display:inline-flex;align-items:center;height:26px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:13px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s,border-color .12s,color .12s}",
      ".hks-tag:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".hks-tag[data-on='1']{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}",
      ".hks-tag:disabled{cursor:not-allowed;opacity:.5}",
      ".hks-grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}",

      /* ── 按钮：原生 Button 规格（胶囊）── */
      ".hks-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:30px;padding:0 14px;border:none;border-radius:15px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap}",
      ".hks-btn:disabled{cursor:not-allowed;opacity:.4}",
      ".hks-btn[data-v=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}",
      ".hks-btn[data-v=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
      ".hks-btn[data-v=outline]{border:1px solid var(--dsw-alias-border-l2)}",
      ".hks-btn[data-v=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-btn[data-v=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-btn[data-v=ghost]:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
      ".hks-btn[data-sz=sm]{height:26px;padding:0 11px;font-size:12px;line-height:18px;border-radius:13px}",
      ".hks-link{display:inline-flex;align-items:center;height:26px;padding:0 4px;border:none;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;border-radius:6px}",
      ".hks-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-link:disabled{cursor:not-allowed;opacity:.4}",

      /* ── 保存状态行：没有保存按钮，改完就去抖提交 ── */
      ".hks-saverow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:18px;padding:0 0 8px}",
      ".hks-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);white-space:pre-line}",
      ".hks-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",

      /* ── 折叠 / 日志 / 二维码 / 页脚 ── */
      ".hks-more{margin-top:2px}",
      ".hks-more>summary{display:flex;align-items:center;gap:4px;padding:8px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer;list-style:none;user-select:none}",
      ".hks-more>summary::-webkit-details-marker{display:none}",
      ".hks-more>summary:hover{color:var(--dsw-alias-label-primary)}",
      ".hks-more>summary::before{content:'▸';font-size:10px;line-height:1;transition:transform .12s}",
      ".hks-more[open]>summary::before{transform:rotate(90deg)}",
      ".hks-log{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow:auto;max-height:260px}",
      ".hks-qrbox{display:flex;align-items:flex-start;gap:12px;padding:8px 0 4px}",
      ".hks-qrimg{flex:none;width:112px;height:112px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:#fff}",
      ".hks-qrph{display:flex;align-items:center;justify-content:center;flex:none;width:112px;height:112px;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".hks-qrside{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
      ".hks-stack{display:flex;flex-direction:column;gap:6px;width:100%}",
      ".hks-rowbtns{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
      ".hks-foot{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── 已登录账号 ── */
      ".hks-acct{display:flex;align-items:center;gap:12px;padding:8px 0 4px}",
      ".hks-ava{flex:none;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600}",
      ".hks-acct-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".hks-acct-n{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".hks-acct-s{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── 小标题 / 板块选择 ── */
      ".hks-h4{margin:14px 0 2px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".hks-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
      ".hks-tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 4px 0 10px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
      ".hks-tag>button{border:0;background:none;padding:0 4px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:18px}",
      ".hks-tag>button:hover{color:var(--dsw-alias-label-primary)}",
      ".hks-pick{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
      ".hks-pick-l{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;max-height:220px;overflow:auto}",
      ".hks-pick-l>button{display:flex;justify-content:space-between;gap:6px;border:0;border-radius:6px;background:none;padding:4px 8px;text-align:left;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}",
      ".hks-pick-l>button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-pick-l>button[data-on='1']{color:var(--dsw-alias-state-success-primary);font-weight:600}",
      ".hks-pick-l>button>span{color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:nowrap}",

      /* ── 身份条：账号 · 人设 · 线路 ── */
      ".hks-id{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 10px}",
      ".hks-idp{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}",
      ".hks-idp:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-idp[data-on='1']{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-idp:disabled{cursor:not-allowed;opacity:.5}",
      ".hks-idp>.hks-idt{color:var(--dsw-alias-label-tertiary)}",
      ".hks-idm{position:absolute;z-index:20;top:36px;left:0;min-width:250px;max-width:360px;display:flex;flex-direction:column;gap:2px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.12)}",
      ".hks-idmi{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:7px;background:none;text-align:left;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}",
      ".hks-idmi:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hks-idmi[data-on='1']{font-weight:600}",
      ".hks-idmi:disabled{cursor:not-allowed;opacity:.45}",
      ".hks-idmi>span{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:nowrap}",
      ".hks-idmsg{padding:6px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
      /* ── 账号清单 / 人设选择行 ── */
      ".hks-accl{display:flex;flex-direction:column;gap:6px;margin-top:6px}",
      ".hks-accl-i{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}",
      ".hks-accl-i[data-on='1']{border-color:var(--dsw-alias-label-primary)}",
      ".hks-accl-n{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:600}",
      ".hks-accl-s{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".hks-accl-in{width:150px;height:26px}",
      ".hks-pbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 10px}",
      ".hks-sel{height:30px;max-width:240px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px}",
      ".hks-inl{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",

      /* ── 窄屏降级：5 个模式卡在 640 以下挤不下，副标题会折成两行 ── */
      "@container (max-width:640px){.hks-modes{grid-template-columns:repeat(3,minmax(0,1fr))}}",
      /* ── 窄屏单列降级 ── */
      "@container (max-width:520px){.hks-grid4{grid-template-columns:repeat(2,minmax(0,1fr))}.hks-row{grid-template-columns:minmax(0,1fr);row-gap:5px;align-items:stretch}.hks-c{justify-content:flex-start}.hks-modes{grid-template-columns:repeat(2,minmax(0,1fr))}.hks-act{grid-template-columns:56px minmax(0,1fr)}.hks-act>b{display:none}.hks-step{grid-template-columns:44px minmax(0,1fr)}.hks-step>span{grid-column:2}.hks-pick-l{grid-template-columns:minmax(0,1fr)}}",
    ].join("");


    /* ───────────────── 提示气泡：界面上的所有说明文字都住在这里 ─────────────────
       复刻平台的 bubble：fixed 定位、13/20、tooltip 底色、pointer-events:none。
       位置在 hover / focus 时才用 getBoundingClientRect 算，纯渲染阶段不读 DOM，
       这样没有浏览器的静态渲染测试也能跑。 */
    function Tip({ text, side, children }) {
      const [pos, setPos] = useState(null);
      const ref = useRef(null);
      const show = useCallback(() => {
        const el = ref.current;
        if (!el || typeof el.getBoundingClientRect !== "function") return;
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const want = side || (r.right + 340 <= vw ? "right" : r.bottom + 90 <= vh ? "bottom" : "top");
        if (want === "right") {
          setPos({ side: "right", left: Math.round(r.right + 8) + "px", top: Math.round(Math.min(vh - 20, Math.max(20, r.top + r.height / 2))) + "px" });
          return;
        }
        // 气泡上限 320px，居中摆时两侧各占 160px；夹一下中心点，别让气泡探出视口
        const half = 168;
        const cx = Math.max(half, Math.min(Math.max(half, vw - half), Math.round(r.left + r.width / 2)));
        setPos({ side: want, left: cx + "px", top: Math.round(want === "bottom" ? r.bottom + 6 : r.top - 6) + "px" });
      }, [side]);
      const hide = useCallback(() => setPos(null), []);
      const bare = children == null || (Array.isArray(children) && children.length === 0);
      const props = { ref, onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
      if (bare) {
        props.className = "hks-i";
        props.tabIndex = 0;
        props.role = "img";
        props["aria-label"] = text;
      } else {
        props.className = "hks-tipslot";
      }
      return h("span", { className: "hks-tipwrap" },
        h("span", props, bare ? "i" : children),
        pos ? h("span", { className: "hks-bubble", role: "tooltip", "data-side": pos.side, style: { left: pos.left, top: pos.top } }, text) : null);
    }

    /* ── 字段清单：唯一真相。sec = 属于哪张卡；tier 1 = 默认显示，tier 2 = 收进「高级」
          hint 不再画在行里，全部由 Row 送进 tooltip。 ── */
    const FIELDS = [
      { sec: "ai", path: ["ai", "baseUrl"], label: "接口地址", hint: "OpenAI 兼容的 base URL。\n只支持 http/https", kind: "text", ph: "https://api.deepseek.com/v1" },
      { sec: "ai", path: ["ai", "model"], label: "模型", hint: "填服务商给的模型名，例如 deepseek-chat", kind: "text", ph: "deepseek-chat" },
      { sec: "ai", path: ["ai", "apiKey"], label: "密钥", hint: "存在 ~/.hykb-ai/ai-key，权限 600。\n保存后只显示掩码，永不回显", kind: "password", ph: "sk-…" },
      /* ───── 决策模型（判官）：只判不发，四组分数一次出完 ───── */
      { sec: "ai", path: ["ai", "judge", "enabled"], label: "决策模型（判官）", hint: "开 = 点赞 / 回帖 / 发帖 / 进报告都先问它一次，一次调用出四组分数。\n关 = 全部退回原来的确定性判据，行为与以前完全一样。\n判官只判不发：它没有点赞、发帖、改配置的能力，分数只是建议。", kind: "switch" },
      { sec: "ai", path: ["ai", "judge", "baseUrl"], label: "判官接口地址", hint: "留空 = 跟随上面的主线路。\n建议单独配一条便宜的：判官按条调用，比写回复频繁得多。", kind: "text", ph: "https://" },
      { sec: "ai", path: ["ai", "judge", "model"], label: "判官模型", hint: "留空 = 跟随主线路。\n判官固定 0.1 温度（要稳），跟写回复那条 0.8 不是一回事。", kind: "text", ph: "deepseek-chat" },
      { sec: "ai", path: ["ai", "judge", "apiKey"], label: "判官密钥", hint: "存在 ~/.hykb-ai/judge-key，权限 600。\n保存后只显示掩码，永不回显", kind: "password", tier: 3, ph: "sk-…" },
      { sec: "ai", path: ["ai", "judge", "thresholds", "like"], label: "点赞线", hint: "分数到多少才够格点赞。判官看不到这个数——阈值在代码里判，模型碰不到。", kind: "number", tier: 3 },
      { sec: "ai", path: ["ai", "judge", "thresholds", "reply"], label: "回帖线", hint: "回帖会署你的名，比点赞贵，所以线更高。", kind: "number", tier: 3 },
      { sec: "ai", path: ["ai", "judge", "thresholds", "publish"], label: "发帖线", hint: "对外发布的候选线，最高。", kind: "number", tier: 3 },
      { sec: "ai", path: ["ai", "judge", "thresholds", "report"], label: "进报告线", hint: "进日报 / 周报的线，最低。\n注意：不能回帖 ≠ 不能进报告，两条分开判。", kind: "number", tier: 3 },
      { sec: "ai", path: ["ai", "temperature"], label: "温度", hint: "0–2，越高越活泼。回帖建议 0.8 左右", kind: "number", tier: 2 },
      { sec: "ai", path: ["ai", "maxTokens"], label: "回复字数上限", hint: "按 token 计。回帖 200–400 就够，写多了反而啰嗦", kind: "number", tier: 2 },

      { sec: "who", path: ["persona", "name"], label: "角色名", hint: "她怎么称呼自己，会出现在回复落款里", kind: "text", ph: "小号" },
      { sec: "who", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "会出现在她写的回复里", kind: "text", ph: "主人" },
      { sec: "who", path: ["persona", "style"], label: "说话风格", hint: "一句话写清口吻和长度，直接影响回帖质量", kind: "text", ph: "像真人回帖，口语，不超过 60 字" },
      { sec: "prompt", path: ["prompt", "rules"], label: "回复前先想的规则", hint: "她每次写要发出去的话（回帖、楼中楼、日报帖）之前，都会先按这里的要求想一遍。\n和内置规则冲突时以这里为准。\n一行一条，例如：不剧透；提到版本号要说是哪个服；不推荐氪金", kind: "textarea", ph: "一行一条。例如：\n不剧透剧情\n别人问攻略时先给结论再给理由" },
      { sec: "prompt", path: ["prompt", "suffix"], label: "末尾固定加一句", hint: "每条发出去的话最后都会带上这一句，由程序追加，不靠模型自觉，不会漏。\n留空 = 强制使用「-内容由AI生成」（AI 生成内容必须带标识，这一条不能关）。\n只允许常见标点、汉字、英文、数字；符号和空白会被自动清掉。最长 60 字", kind: "text", ph: "-内容由AI生成" },
      { sec: "who", path: ["owner", "uid"], label: "你的 uid（大号）", hint: "填了以后只回你这个号的楼，别人的 @ 一律跳过", kind: "text", tier: 2 },
      { sec: "who", path: ["owner", "name"], label: "你的昵称", hint: "只用于日志，不参与判断", kind: "text", tier: 2 },

      { sec: "reply", path: ["listen", "jitterSec"], label: "扫描抖动（±秒）", hint: "默认 3。实际间隔 = 上面的扫描间隔 ± 这个数，例如间隔 20 秒、抖动 2 秒 → 每轮在 18–22 秒之间随机。\n填 0 = 不抖（固定间隔，最容易被看出是机器）", kind: "number" },
      { sec: "reply", path: ["listen", "windows"], label: "时间段", hint: "写成 08:00-24:00；跨零点写 22:00-06:00。\n多个时段用逗号隔开", kind: "windows", tier: 2 },
      { sec: "reply", path: ["listen", "oncePerPerson"], label: "同一个人只回一次", hint: "30 天内同一个人只回一条，防刷屏", kind: "switch", tier: 2 },
      { sec: "reply", path: ["listen", "maxTopicsPerTick"], label: "每轮最多读几帖", hint: "默认 6。列了很多帖时只读前几个，省读额度", kind: "number", tier: 2 },
      { sec: "reply", path: ["listen", "maxRepliesPerTick"], label: "每轮最多回几条", hint: "默认 3。一轮扫到的 @ 不会全回一遍", kind: "number", tier: 2 },

      // ⑤ 回复我的：消息中心三个频道。通知里就带着对方那句话和帖/楼 id，
      //    所以这条源只花一次通知列表的读额度，不额外读帖、不花词元。
      { sec: "reply", path: ["listen", "replies", "enabled"], label: "接「回复我的」通知", hint: "读消息中心「回复我的」频道（101 / 102 / 103 三类）。\n关掉 = 只认 @，别人回到你说的话下面也不接话。", kind: "switch" },
      { sec: "reply", path: ["listen", "replies", "onComment"], label: "有人回你的回复时接话", hint: "103：别人在你的楼中楼回复下面接话。\n这是「回到我说的话下面」的第二种，默认开", kind: "switch" },
      { sec: "reply", path: ["listen", "replies", "onFloor"], label: "有人回你的回帖时接话", hint: "102：别人新发一层楼、指的是你那层楼。\n默认开", kind: "switch" },
      { sec: "reply", path: ["listen", "replies", "onPost"], label: "你帖子下的新回复也接话", hint: "101：别人在你的帖子里发新回复（不一定是跟你说话）。\n默认关 —— 开着容易在你自己的楼里跟每个人各聊一句", kind: "switch" },
      { sec: "reply", path: ["listen", "replies", "maxAgeMin"], label: "只处理多久内的通知（分钟）", hint: "默认 720（12 小时）。通知里的时间是「11小时前」这种人话，解析不了的一律放行", kind: "number", tier: 2 },

      // ⑥ 假 @ 兜底：纯文本「@昵称」平台不发通知，只能扫正文。只占读额度，不花词元。
      { sec: "reply", path: ["listen", "scanMine", "enabled"], label: "扫我参与过的帖，认纯文本 @", hint: "把小号发过的帖、回过帖的帖子自动纳入扫描，正文里出现「@你的昵称」就算叫你。\n纯文本 @ 不产生任何通知，这是唯一能接住它的路；不调模型、只花读额度", kind: "switch" },
      { sec: "reply", path: ["listen", "scanMine", "maxTopicsPerTick"], label: "每轮最多扫几帖", hint: "默认 2，按游标轮转。每帖一次读请求，\n读额度每小时 600 次，「安全阀」里能看到用了多少", kind: "number", tier: 2 },

      { sec: "browse", path: ["browse", "intervalSec"], label: "多久刷一轮（秒）", hint: "默认 3600，一小时一轮", kind: "number" },
      { sec: "browse", path: ["browse", "jitterSec"], label: "刷帖抖动（±秒）", hint: "默认 60。实际间隔 = 上面那个 ± 这个数。\n填 0 = 不抖", kind: "number" },
      { sec: "browse", path: ["browse", "pick"], label: "日报写几帖", hint: "默认 8。写太多 AI 会开始编", kind: "number" },
      { sec: "browse", path: ["browse", "deep"], label: "深读几帖", hint: "前几帖拉楼层压成速读，再合成日报", kind: "number" },
      { sec: "browse", path: ["summary", "maxComments"], label: "深读每帖读几层", hint: "默认 50。几百层的大帖靠它压住读额度", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "wake"], label: "刷完叫醒她", hint: "关掉 = 只写日报文件，不在她会话里说话", kind: "switch" },
      { sec: "browse", path: ["browse", "autoReply"], label: "顺手回高分帖", hint: "会真的发出去。只回分数线以上的帖，\n仍受「安全阀」里的写额度与写冷却约束", kind: "switch" },
      { sec: "browse", path: ["browse", "replyMinScore"], label: "回帖分数线", hint: "低于这个分不回，默认 40", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "replyMax"], label: "每轮最多回几条", hint: "默认 3", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "allDay"], label: "全天刷", hint: "关掉后只在时间段里刷", kind: "switch", tier: 2 },

      // 个性化题材：宿主侧硬加权（命中加分、全不命中减分），也点一句进日报提示词。
      // 这份清单与 tools/lib/config.mjs 的 INTEREST_TAGS 必须一致（tests/ui.test.mjs 有对账）。
      { sec: "browse", path: ["browse", "interests", "tags"], label: "个性化题材", kind: "tags",
        hint: "点选他常年爱看的题材。命中的帖在打分时加分、\n一个都不命中的减分，日报提示词里也会提一句。\n一个都不选 = 完全不干预，打分与以前一模一样",
        opts: ["游戏", "生活日常", "数码", "影视动漫", "福利", "社区活动"] },
      { sec: "browse", path: ["browse", "interests", "custom"], label: "自定义题材", hint: "逗号分隔，和上面的点选合并去重。\n例如：独立游戏，跑团，老游戏考古", kind: "list", ph: "逗号分隔" },
      { sec: "browse", path: ["browse", "interests", "weight"], label: "题材加减分", hint: "默认 10（0–30 分）。命中一个题材加这个分，一个都不命中减这个分。\n填 0 = 只按口味提示、不参与打分（纯软偏好）；想彻底关掉就把上面题材全清空", kind: "number", tier: 2 },

      // 游戏评价观察（只读）：只影响日报里多出来的那一段
      { sec: "games", path: ["games", "pick"], label: "每轮看几个游戏", hint: "默认 3。只有填了游戏清单时才受限，没填就从榜单里按顺序取前几个", kind: "number" },
      { sec: "games", path: ["games", "maxComments"], label: "每个游戏读几条评价", hint: "默认 20。读的是评价正文，多了是白烧读额度", kind: "number", tier: 2 },
      { sec: "games", path: ["games", "minLen"], label: "多短的评价丢掉", hint: "默认 12 字。纯表情、「好玩」这种凑字的会被过滤", kind: "number", tier: 2 },

      { sec: "post", path: ["post", "title"], label: "帖子标题", hint: "{date} 会换成当天日期。平台限 48 字，超了会截断。\n同一天发第二篇会自动加「· 2」", kind: "text", ph: "快爆论坛日报 {date}" },
      { sec: "post", path: ["post", "links"], label: "文末附原帖链接", hint: "在帖子最后列出这期写到的每一帖：标题 + 链接。\n链接由程序拼，不让模型编", kind: "switch" },
      { sec: "post", path: ["post", "maxPerDay"], label: "一天最多发几篇", hint: "1–5，默认 1。日报每轮都会跑，不卡就会刷屏", kind: "number", tier: 2 },
      { sec: "post", path: ["post", "minPicks"], label: "少于几帖不发", hint: "这一轮选到的帖子不够这个数就不发，默认 3", kind: "number", tier: 2 },

      // 自动点赞：三类各一个开关（没有总开关），额度与判定分开填
      { sec: "like", path: ["like", "browsed"], label: "浏览过的自动点赞", hint: "这一轮真读到、并且读过楼层的帖子，给帖子本身点一个赞。\n只赞本轮读到的，不去翻旧账", kind: "switch" },
      { sec: "like", path: ["like", "quality"], label: "优质内容自动点赞", hint: "打分过线的帖子，连同它下面最热的几条评论一起赞。\n热评赞几条由「每帖最多赞几条热评」定", kind: "switch" },
      { sec: "like", path: ["like", "replies"], label: "回复内容自动点赞", hint: "评论区 / 楼中楼里别人写的回复（不含她自己发的）。\n赞的是这条回复，不是帖子本身", kind: "switch" },
      { sec: "like", path: ["like", "perRoundMax"], label: "每轮最多点赞几个", hint: "默认 5，上面三类合计。到数就停，下一轮重新算。\n每点一次都算一次写，仍受「安全阀」的写额度与写冷却约束", kind: "number" },
      { sec: "like", path: ["like", "qualityJudge"], label: "优质判定", hint: "本地打分：用回帖那套评分规则，不额外调模型，快且不花词元。\nAI 逐条判：每条都让模型判一次值不值得赞，准一些但慢、吃词元。", kind: "seg", opts: [{ key: "score", t: "本地打分" }, { key: "ai", t: "AI 逐条判" }] },
      { sec: "like", path: ["like", "qualityMinScore"], label: "优质分数线", hint: "默认 40，和「回帖分数线」同一套分。\n选「AI 逐条判」时这条不生效", kind: "number", tier: 2 },
      { sec: "like", path: ["like", "aiConfirmMax"], label: "每轮最多让 AI 判几条", hint: "默认 3。用来限住模型成本：一轮只有这么多条进模型，\n余下的按本地分数处理", kind: "number", tier: 2 },
      { sec: "like", path: ["like", "hotCommentsPerTopic"], label: "每帖最多赞几条热评", hint: "默认 2。「优质内容自动点赞」开着时，除了帖子本身，\n还赞它下面按点赞数排前几的评论", kind: "number", tier: 2 },

      // 自动回关
      { sec: "focus", path: ["followback", "dailyCap"], label: "一天最多回关几个", hint: "1–100，默认 20。到点自动停，0 点清零", kind: "number" },
      { sec: "focus", path: ["followback", "onlyNonMutual"], label: "只回关没互关的", hint: "开：只处理「他关注了我、我还没回关」（以「我的关注」列表为准）。\n关：粉丝列表里的都算，可能对已回关的人重复记一笔", kind: "switch" },
      { sec: "focus", path: ["followback", "maxPages"], label: "每轮检测几个", hint: "粉丝与关注列表每轮各检测几个，默认 3。检测多了费读额度", kind: "number", tier: 2 },

      { sec: "risk", path: ["risk", "writeGapSec"], label: "两次写之间隔（秒）", hint: "默认 120。太密容易被风控", kind: "number" },
      { sec: "risk", path: ["risk", "writeHourly"], label: "每小时最多写几条", hint: "默认 12", kind: "number" },
      { sec: "risk", path: ["risk", "writeDaily"], label: "每天最多写几条", hint: "默认 30。超过 50 像刷量", kind: "number" },
      { sec: "risk", path: ["risk", "readHourly"], label: "每小时最多读几次", hint: "默认 600，可填 60–6000。\n算的是向快爆发出的请求次数，不是扫描轮数：\n回帖每轮至少读 @我 通知 1 次 + 每个监听板块 1 次，盯的帖子、命中的楼层另算；\n刷帖每轮按板块、页数、深读帖子数读几十次。\n日志里能看到本小时 / 今天各用了多少", kind: "number" },
      { sec: "risk", path: ["risk", "readDaily"], label: "每天最多读几次", hint: "默认 3000，可填 300–50000。到 0 点清零", kind: "number" },
      { sec: "risk", path: ["risk", "minGapMs"], label: "两次读之间最少隔（毫秒）", hint: "默认 1500，可填 500–10000。\n它决定读的最快速度：1500 毫秒一次，每小时最多约 2400 次，\n所以「每小时最多读几次」填得再高也超不过这个数", kind: "number" },
      { sec: "risk", path: ["risk", "gapJitterMs"], label: "每次读再抖（±毫秒）", hint: "默认 400。固定毫秒节奏本身就是指纹：每 1500ms 一次、误差 0，比抖动的更像机器。\n填 0 = 不抖", kind: "number", tier: 3 },
      { sec: "risk", path: ["risk", "dedupeDays"], label: "复读查重窗口（天）", hint: "默认 14。同一句（或很像的一句）在这个窗口内说过就不再发。\n填 0 = 关掉查重。复读比频率更容易被认出是机器。", kind: "number", tier: 3 },
      { sec: "risk", path: ["risk", "dedupeSimilar"], label: "判为复读的相似度", hint: "默认 0.86，可填 0.5–1。1 = 只有一字不差才算复读；越低越严格。\n中文按字符二元组比对，不需要分词。", kind: "number", tier: 3 },

      // 内容安全：三个类目 + 两道闸 + 命中话术。词表靠「看词表」按钮现拉，不进 FIELDS
      { sec: "risk", path: ["safety", "politics"], label: "国家 / 政治类不接", hint: "政治口号、分裂主张、涉政事件与人名。\n拦的是具体主张与事件，不是词面像", tier: 9, kind: "switch" },
      { sec: "risk", path: ["safety", "sexual"], label: "色情类不接", hint: "色情交易、器官、性行为的露骨词，以及 porn / nsfw 这类英文词", tier: 9, kind: "switch" },
      { sec: "risk", path: ["safety", "violence"], label: "血腥暴力类不接", hint: "虐杀、分尸、自杀方式、爆炸物制作这类词。\n游戏里的「屠龙宝刀」这类误伤可以填进例外词", tier: 9, kind: "switch" },
      { sec: "risk", path: ["safety", "blockInbound"], label: "别人写的命中就不接话", hint: "这道闸在调用模型之前判：命中就跳过或回固定话术，一次模型都不调，不花词元", tier: 9, kind: "switch" },
      { sec: "risk", path: ["safety", "blockOutbound"], label: "模型写的命中就不发", hint: "这道闸在生成之后判：真写出来了就整条不发", tier: 9, kind: "switch" },
      { sec: "risk", path: ["safety", "replyOnOutbound"], label: "出站命中时也回那句话术", hint: "默认关：模型自己写跑偏时宁可不发", kind: "switch", tier: 9 },
      { sec: "risk", path: ["safety", "extraWords"], label: "自加违禁词", hint: "逗号分隔。和内置词一样，入站出站两边都拦", kind: "list", tier: 9, ph: "逗号分隔" },
      { sec: "risk", path: ["safety", "allowWords"], label: "例外词（不拦）", hint: "逗号分隔。游戏语境里正常的词填这里，例如 屠龙宝刀", kind: "list", tier: 9, ph: "逗号分隔" },
      // 平台词表预检（快爆自己的敏感词接口）：只在「内容安全」卡里渲染，tier 9 不进通用渲染
      { sec: "risk", path: ["safety", "maskword", "enabled"], label: "快爆平台词表预检", hint: "发出去之前，再问一次快爆自己的敏感词接口。\n本地词表是我们自己攒的，平台词表才是真正会拦你的那一份。\n没配 appid 与密钥时这一步自动跳过", kind: "switch", tier: 9 },
      { sec: "risk", path: ["safety", "maskword", "appid"], label: "平台预检 appid", hint: "快爆分配的 appid（文档示例是 kbtest）。\nappid + 密钥都填了才算配好", kind: "text", tier: 9, ph: "kbtest" },
      { sec: "risk", path: ["safety", "maskword", "key"], label: "平台预检密钥", hint: "存在 ~/.hykb-ai/maskword-key，权限 600。\n保存后只显示掩码，永不回显", kind: "password", tier: 9, ph: "分配的秘钥" },
      { sec: "risk", path: ["safety", "maskword", "level"], label: "平台预检级别", hint: "接口的 level 参数，文档里 1 = 严格。保持默认即可", kind: "number", tier: 9 },

      // 中转站：走哪条由卡片里的线路按钮控制（见「当前线路」那一行），
      // 这里只留"要不要回退"这个开关。
      { sec: "ai", path: ["ai", "fallback"], label: "主线路失败自动换下一条", hint: "开着 = 按顺序试所有可用线路，全失败才报错。\n关掉 = 只试当前线路。\n注意：内容审核拒答（Content Exists Risk / 拒答）不算线路故障，不会触发换线", kind: "switch", tier: 3 },
      { sec: "ai", path: ["ai", "safetyCheck"], label: "DeepSeek 官方内容审核", hint: "强制开启，不提供关闭档位：这是对外发帖的机器人，服务端审核输入与输出是合规底线。\n只在 api.deepseek.com 上生效；中转站收到这个字段会 400，所以不会塞给它们。", kind: "seg", tier: 3,
        opts: [{ key: "high", t: "强制开启（high）" }], readOnly: true },
    ];

    /** 设置项住在哪张卡：搜索结果显示「设置项名 · 卡片名」，跳转也按它找卡 */
    const CARD_OF = {
      ai: "接上 AI",
      who: "她是谁",
      prompt: "她是谁",
      reply: "自动回帖",
      browse: "刷论坛 · 日报发帖",
      post: "刷论坛 · 日报发帖",
      games: "刷论坛 · 日报发帖",
      like: "自动点赞",
      focus: "自动回关",
      risk: "安全阀",
      safety: "内容安全",
    };
    const CARD_FALLBACK = "其他设置";

    const flat = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();

    /**
     * 设置项搜索：匹配范围 = label + hint + 所属卡标题。
     * 中文按子串，英文不分大小写（两边都小写再比）；空输入不出结果。
     * 纯函数：不碰 DOM，单测直接喂 FIELDS 就能验（见 tests/ui-search.test.mjs）。
     */
    function matchFields(fields, query, limit) {
      const q = flat(query);
      if (!q) return [];
      const cap = Math.max(1, Number(limit) || 3);
      const out = [];
      for (const f of fields) {
        const card = CARD_OF[f.sec] || CARD_FALLBACK;
        if (!flat(f.label + " " + (f.hint || "") + " " + card).includes(q)) continue;
        out.push({ key: f.path.join("."), label: f.label, card, field: f });
        if (out.length >= cap) break;
      }
      return out;
    }

    /* ───────────────── 取值 / 写值 / 差异 ───────────────── */

    /** "08:00-24:00, 22:00-06:00" ⇄ [{start,end}] */
    const parseWindows = (text) =>
      String(text || "")
        .split(/[,，\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.match(/^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/);
          return m ? { start: m[1], end: m[2] } : null;
        })
        .filter(Boolean);
    const parseList = (s) => String(s || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

    /** 不可变写入：路径上每一层都换新对象。
        自动保存靠引用判断「这份是不是新的」，就地改会让排队中的那份被后续改动污染。 */
    const setPath = (obj, path, value) => {
      if (!path.length) return value;
      const [k, ...rest] = path;
      const src = obj == null || typeof obj !== "object" ? (typeof k === "number" ? [] : {}) : obj;
      const next = Array.isArray(src) ? src.slice() : { ...src };
      next[k] = rest.length ? setPath(src[k], rest, value) : value;
      return next;
    };

    /* ───────────────── 基础件 ───────────────── */

    function Sw({ on, onChange, disabled }) {
      return h("button", {
        type: "button",
        className: "hks-sw",
        "data-on": on ? 1 : 0,
        role: "switch",
        "aria-checked": !!on,
        disabled,
        onClick: () => onChange(!on),
      });
    }

    /** 行：左标签（+ⓘ），右控件。hint 一律进 tooltip；block=true 时控件换行占满整行。
        hp = 字段路径：搜索跳转按 data-hks-path 找这一行。 */
    function Row({ label, hint, block, children, side, hp, "data-bad": bad }) {
      const head = h("div", { className: "hks-l" },
        h("span", { className: "hks-lbl" }, label),
        hint ? h(Tip, { text: hint, side }) : null);
      // hks-path 供搜索跳转定位；data-bad 供保存闸描红。两个标记各自独立，不能互相覆盖。
      const attrs = { ...(hp ? { "data-hks-path": hp } : null), ...(bad ? { "data-bad": "1" } : null) };
      if (block) return h("div", { className: "hks-row hks-row--block", ...attrs }, head, children);
      return h("div", { className: "hks-row", ...attrs }, head, h("div", { className: "hks-c" }, children));
    }

    function SwRow({ label, hint, on, onChange, disabled }) {
      return h(Row, { label, hint },
        h(Sw, { on: !!on, onChange, disabled }));
    }

    /** 逗号列表输入：本地保留原文，避免边打字边被切碎 */
    function ListInput({ value, onChange, placeholder, disabled }) {
      const arr = Array.isArray(value) ? value : [];
      const key = arr.join("，");
      const [text, setText] = useState(key);
      useEffect(() => {
        setText((t) => (parseList(t).join("，") === key ? t : key));
      }, [key]);
      return h("input", {
        className: "hks-in",
        value: text,
        placeholder: placeholder || "逗号分隔",
        disabled,
        onChange: (e) => { setText(e.target.value); onChange(parseList(e.target.value)); },
      });
    }

    function Field({ field, cfg, setCfg, disabled, bad }) {
      const raw = getPath(cfg, field.path);
      const off = disabled || field.readOnly;
      const hp = field.path.join(".");
      const set = (v) => setCfg((c) => setPath(c, field.path, v));
      /* 被保存闸拦下时把这一行描红（bad 由上层按 label 匹配传进来）。
         只描红，不写命中词 —— 命中的词不进界面。 */
      const mark = bad ? { "data-bad": "1" } : null;
      let control;
      if (field.kind === "switch") {
        control = h(Sw, { on: !!raw, onChange: set, disabled: off });
      } else if (field.kind === "seg") {
        const opts = field.opts || [];
        const cur = raw == null ? (opts[0] && opts[0].key) : raw;
        return h(Row, { label: field.label, hint: field.hint, block: true, hp, ...mark },
          h("div", { className: "hks-seg" }, opts.map((o) => h("button", {
            key: o.key, type: "button", "data-on": cur === o.key ? 1 : 0, disabled: off,
            onClick: () => set(o.key),
          }, o.t))));
      } else if (field.kind === "tags") {
        const opts = field.opts || [];
        const cur = Array.isArray(raw) ? raw : [];
        const toggle = (t) => set(cur.indexOf(t) >= 0 ? cur.filter((x) => x !== t) : cur.concat([t]));
        return h(Row, { label: field.label, hint: field.hint, block: true, hp, ...mark },
          h("div", { className: "hks-tags" }, opts.map((t) => h("button", {
            key: t, type: "button", className: "hks-tag", "data-on": cur.indexOf(t) >= 0 ? 1 : 0,
            disabled: off, onClick: () => toggle(t),
          }, t))));
      } else if (field.kind === "list") {
        control = h(ListInput, { value: raw, onChange: set, placeholder: field.ph, disabled: off });
      } else if (field.kind === "windows") {
        control = h(ListInput, {
          value: Array.isArray(raw) ? raw.map((w) => w.start + "-" + w.end) : [],
          onChange: (arr) => set(arr.map((s) => {
            const m = String(s).match(/^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/);
            return m ? { start: m[1], end: m[2] } : null;
          }).filter(Boolean)),
          placeholder: "08:00-24:00",
          disabled: off,
        });
      } else if (field.kind === "textarea") {
        return h(Row, { label: field.label, hint: field.hint, block: true, hp, ...mark },
          h("textarea", {
            className: "hks-ta", value: raw ?? "", placeholder: field.ph || "", disabled: off,
            onChange: (e) => set(e.target.value),
          }));
      } else if (field.kind === "number") {
        control = h("input", {
          className: "hks-in", type: "number", value: raw ?? "", disabled: off,
          onChange: (e) => set(e.target.value === "" ? "" : Number(e.target.value)),
        });
      } else {
        control = h("input", {
          className: "hks-in",
          type: field.kind === "password" ? "password" : "text",
          autoComplete: "off",
          value: raw ?? "",
          placeholder: field.ph || "",
          disabled: off,
          onChange: (e) => set(e.target.value),
        });
      }
      return h(Row, { label: field.label, hint: field.hint, hp, ...mark }, control);
    }

    /** 卡片折叠状态存本地：默认全展开，收起过哪张记住哪张 */
    const CLOSED_KEY = "hykb-scroll:card-closed";
    let closedMap = null;
    const loadClosed = () => {
      if (closedMap) return closedMap;
      closedMap = {};
      try {
        const raw = typeof localStorage === "undefined" ? "" : localStorage.getItem(CLOSED_KEY);
        const j = raw ? JSON.parse(raw) : null;
        if (j && typeof j === "object") for (const k of Object.keys(j)) if (j[k]) closedMap[k] = 1;
      } catch {}
      return closedMap;
    };
    const isClosed = (key) => !!(key && loadClosed()[key]);
    const rememberClosed = (key, v) => {
      if (!key) return;
      const m = loadClosed();
      if (v) m[key] = 1; else delete m[key];
      try { if (typeof localStorage !== "undefined") localStorage.setItem(CLOSED_KEY, JSON.stringify(m)); } catch {}
    };

    /** 一张卡：序号 + 标题 + 一句副标题 + 可选右上开关 + 右上折叠箭头。off=true 时正文不渲染，也没箭头（开关关着，没有可展开的东西） */
    /** 卡片标题旁的 ⓘ：hover / focus 才出气泡，文字住在这里不占版面 */
    function Card({ id, no, title, sub, badge, right, off, sec, onToggle, children }) {
      const ck = id || sec || (no ? "n" + no : null);
      const [closed, setClosed] = useState(!!ck && isClosed(ck));
      const canFold = !!children && !off;
      const toggle = () => {
        const v = !closed;
        setClosed(v);
        rememberClosed(ck, v);
        if (onToggle) onToggle(v);
      };
      return h("section", { className: "hks-card", "data-off": off ? 1 : 0, "data-closed": canFold && closed ? 1 : 0, "data-n": no ? String(no) : undefined, "data-hks-sec": sec },
        h("div", { className: "hks-chead" },
          no ? h("div", { className: "hks-no" }, String(no)) : null,
          h("div", { className: "hks-ct" },
            h("h4", null, title,
              badge ? h("span", { className: "hks-badge", "data-s": badge.s }, badge.t) : null),
            sub ? h("p", null, sub) : null),
          right || null,
          canFold
            ? h("button", {
                type: "button", className: "hks-chev", "data-open": closed ? 0 : 1,
                "aria-expanded": closed ? "false" : "true", "aria-label": closed ? "展开" : "收起",
                title: closed ? "展开" : "收起",
                onClick: toggle,
              })
            : null),
        children ? h("div", { className: "hks-cbody" }, children) : null);
    }

    /** 卡片里的「高级」折叠 */
    function More({ children, label }) {
      return h("details", { className: "hks-more" },
        h("summary", null, label || "高级"),
        children);
    }

    /** 必须先看见的那类提醒：整行虚线警告框，标题加粗，不是 tooltip。 */
    function WarnBar({ text, sub }) {
      return h("div", { className: "hks-warn" },
        h("b", null, text),
        sub ? h("span", null, sub) : null);
    }

    /**
     * 中转站线路列表。
     * 密钥不进 cfg（会被整份回写、也会被回显），只存在组件的本地 state 里，
     * 提交时和 config 一起 POST 成 keys: { relayId: 明文 }；提交成功后客户端把这份明文清空。
     */
    function RelayList({ relays, disabled, keys, setKey, onAdd, onDrop, onToggle, onChange }) {
      const list = Array.isArray(relays) ? relays : [];
      return h("div", { className: "hks-stack" },
        list.length
          ? list.map((r) => h("div", { key: r.id, className: "hks-relay" },
              h("div", { className: "hks-relay-h" },
                h(Sw, { on: r.enabled !== false, disabled, onChange: (v) => onToggle(r.id, v) }),
                h("b", null, r.name || r.id),
                h("span", { className: "hks-note" }, r.id),
                h("button", { type: "button", className: "hks-link", disabled, onClick: () => onDrop(r.id) }, "删掉")),
              h("div", { className: "hks-relay-g" },
                h("input", {
                  className: "hks-in", value: r.baseUrl || "", disabled,
                  placeholder: "接口地址，例如 https://api.xxx.com/v1",
                  onChange: (e) => onChange(r.id, "baseUrl", e.target.value),
                }),
                h("input", {
                  className: "hks-in", value: r.model || "", disabled,
                  placeholder: "模型名",
                  onChange: (e) => onChange(r.id, "model", e.target.value),
                }),
                h("input", {
                  className: "hks-in", type: "password", autoComplete: "off", disabled,
                  value: keys[r.id] || "",
                  placeholder: r.hasKey ? "已保存（换一个就填新的）" : "sk-…",
                  onChange: (e) => setKey(r.id, e.target.value),
                }))))
          : h("div", { className: "hks-note" }, "还没有中转站。只填上面那三行直连也能用。"),
        h("div", { className: "hks-rowbtns", style: { justifyContent: "flex-start", paddingTop: "6px" } },
          h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled, onClick: onAdd }, "添加中转站"),
          h(Tip, { text: "一条中转站 = 一个接口地址 + 一个模型名 + 一个密钥。\n「当前线路」选哪条就先走哪条；主线路失败会自动换下一条（可在下面关掉回退）。", side: "right" })));
    }

    /* ───────────────── 扫码登录 ───────────────── */

    function QrLogin({ disabled, onAccount, onActiveChange, ck, setCk, onSave, saving, msg }) {
      const [qr, setQr] = useState(null);
      const [phase, setPhase] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const timer = useRef(null);
      const alive = useRef(true);
      // "qr" 扫码 / "cookie" 手动粘贴登录态，两条路随时可切
      const [mode, setMode] = useState("qr");
      // 扫码成功的一次性回执；不放 phase 里，是因为 phase 会被轮询下一次覆盖
      const [ok, setOk] = useState("");

      const clear = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        if (onActiveChange) onActiveChange(false);
      }, [onActiveChange]);
      useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

      const stop = useCallback(() => { clear(); setPhase(""); setQr(null); setOk(""); }, [clear]);

      // 服务端 /auth/qr/poll 只认 POST，回的是 { ok, phase, done, uid, nickname, error }。
      const TEXT = {
        WAIT: "等待扫码",
        SCANNED: "已扫码，在手机上点确认",
        CONFIRMED: "手机已确认，正在向服务端换凭据（几秒）",
        AUTH: "手机已确认，正在向服务端换凭据（几秒）",
        NEED_IDCARD: "这个账号没实名，去网页端补完再扫一次",
        AUTH_FAILED: "确认了但服务端没下发凭据，点「重新获取」再扫一次",
        EXPIRED: "二维码过期了，点「重新获取」",
        CANCELLED: "手机上取消了",
      };

      const poll = useCallback(async () => {
        if (!alive.current) return;
        let terminal = false;
        try {
          const r = await fetch(API + "/auth/qr/poll", { method: "POST" });
          const j = await r.json();
          if (!alive.current) return;
          if (!j.ok) {
            setPhase("");
            setError(j.error || ("查询失败（HTTP " + r.status + "）"));
            terminal = r.status >= 400 && r.status < 500;
          } else if (j.done) {
            // 服务端此时已经把凭据落盘了，这里只做三件事：清掉二维码、给回执、让上层重读配置
            setPhase("");
            setQr(null);
            setError("");
            setOk("✓ 已登录：" + (j.nickname || "（没昵称）") + "（" + (j.uid || "") + "）");
            terminal = true;
            if (onAccount) onAccount({ uid: j.uid || "", nickname: j.nickname || "" });
          } else {
            setPhase(TEXT[j.phase] || "等待扫码");
            if (j.error) setError(j.error);
            if (j.phase === "EXPIRED" || j.phase === "CANCELLED" || j.phase === "NEED_IDCARD" || j.phase === "AUTH_FAILED") terminal = true;
          }
        } catch (e) { setError(String(e.message || e)); }
        if (terminal) { clear(); return; }
        timer.current = setTimeout(poll, 2000);
      }, [onAccount, clear]);

      const start = useCallback(async () => {
        setBusy(true); setError(""); setQr(null); setPhase(""); setOk("");
        if (onActiveChange) onActiveChange(true);
        try {
          const r = await fetch(API + "/auth/qr/start", { method: "POST" });
          const j = await r.json();
          if (!j.ok) { setError(j.error || "取二维码失败"); if (onActiveChange) onActiveChange(false); return; }
          setQr({ image: j.image || "" });
          setPhase("等待扫码");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(poll, 1500);
        } catch (e) {
          setError(String(e.message || e));
          if (onActiveChange) onActiveChange(false);
        } finally { setBusy(false); }
      }, [poll, onActiveChange]);

      const running = !!qr || !!phase;
      const pick = (k, e) => setCk((cur) => ({ ...cur, [k]: e.target.value }));

      // 手动填的一格；password 只挡肩窥，提交后服务端落盘 600，永不回显
      const field = (k, ph, secret) => h("input", {
        key: k, className: "hks-in", autoComplete: "off",
        type: secret ? "password" : "text",
        placeholder: ph, value: ck[k] || "",
        disabled: disabled || saving,
        onChange: (e) => pick(k, e),
      });

      return h("div", null,
        h("div", { className: "hks-tabs" },
          h("div", { className: "hks-seg" }, [
            h("button", { key: "qr", type: "button", "data-on": mode === "qr" ? 1 : 0, disabled: saving, onClick: () => setMode("qr") }, "扫码登录"),
            h("button", { key: "ck", type: "button", "data-on": mode === "cookie" ? 1 : 0, disabled: saving, onClick: () => { stop(); setMode("cookie"); } }, "手动填 Cookie"),
          ]),
          h(Tip, { text: "两条路等效：扫码走手机确认，手动填是从浏览器复制现成的登录态。\n手动填适合扫码一直失败、或者已经有别的号在浏览器里登着的时候。", side: "bottom" })),

        mode === "qr"
          ? h("div", { className: "hks-qrbox" },
              qr && qr.image
                ? h("img", { className: "hks-qrimg", src: qr.image, alt: "好游快爆登录二维码", width: 112, height: 112 })
                : h("div", { className: "hks-qrph" }, busy ? "生成中…" : "二维码"),
              h("div", { className: "hks-qrside" },
                ok ? h("div", { className: "hks-ok" }, ok) : h("div", { className: "hks-note" }, phase || "用手机上的好游快爆 App 扫这个码"),
                error ? h("div", { className: "hks-err" }, error) : null,
                h("div", { className: "hks-rowbtns", style: { justifyContent: "flex-start", paddingTop: "2px" } },
                  h("button", { type: "button", className: "hks-btn", "data-v": "primary", "data-sz": "sm", onClick: start, disabled: disabled || busy },
                    busy ? "获取中…" : qr ? "重新获取" : "扫码登录"),
                  running ? h("button", { type: "button", className: "hks-btn", "data-v": "ghost", "data-sz": "sm", onClick: stop, disabled: busy }, "取消") : null)))
          : h("div", null,
              h("div", { className: "hks-grid4" }, [
                field("uid", "uid（必填）", false),
                field("nickname", "昵称（可空）", false),
                field("Pauth", "Pauth（必填）", true),
                field("Uauth", "Uauth（可空）", true),
              ]),
              h("div", { className: "hks-rowbtns", style: { justifyContent: "flex-start", paddingTop: "8px" } },
                h("button", { type: "button", className: "hks-btn", "data-v": "primary", "data-sz": "sm", onClick: onSave, disabled: disabled || saving || !ck.uid || !ck.Pauth },
                  saving ? "写入中…" : "写入凭据"),
                h(Tip, { text: "浏览器 F12 → Application → Cookies → www.3839.com，复制 uid / Pauth / Uauth。\n写入 ~/.hykb-ai，权限 600，页面永不回显。", side: "right" })),
              msg ? h("div", { className: msg.startsWith("✓") ? "hks-ok" : "hks-err", style: { paddingTop: "6px" } }, msg) : null));
    }

    /* ───────────────── 游戏评价观察的四个榜单 ───────────────── */
    // 只有这四个页是服务端渲染的；二次元/玩家/开发者榜由 top.js 现拉数据，解析不到
    const GAME_SOURCES = [
      { key: "hot", t: "热门" },
      { key: "sugar", t: "飙升" },
      { key: "expect", t: "预约" },
      { key: "down", t: "下载" },
    ];

    /* ───────────────── 四个监听源 ───────────────── */

    const SOURCES = [
      {
        key: "atme", tab: "@ 我通知", noItems: true,
        hint: "直接读消息中心的「@我的」列表。不用填任何 ID，也不用开别的源——别人 @ 她就能回",
      },
      {
        key: "forum", tab: "板块",
        hint: "扫这个板块里的最新帖。板块 ID 可以先点「查板块 ID」看一眼",
        itemsLabel: "板块 ID", itemsHint: "每行一个，可以写「23064 爆友生活区」，标题只是备注", itemsPh: "23064 爆友生活区",
      },
      {
        key: "topic", tab: "帖子",
        hint: "盯住指定帖子的楼层和楼中楼。可以直接粘链接",
        itemsLabel: "帖子", itemsHint: "每行一个，可以写「9251547 歌友会投票」", itemsPh: "9251547",
        extra: [
          { path: ["floors"], label: "扫主楼层", hint: "帖子里的每一层" },
          { path: ["comments"], label: "扫楼中楼", hint: "楼层下面的回复" },
        ],
      },
      {
        key: "at", tab: "@ 的规矩",
        hint: "对上面所有源扫到的内容统一判定「算不算叫我」。留空 = 谁 @ 都算，任何板块任何帖子都算",
        itemsLabel: "额外要看的帖子", itemsHint: "前两个源没覆盖到的帖子写这里——填了以后它同时变成「只在这些帖子里算 @」", itemsPh: "9251547",
        forums: true,
      },
    ];

    const FILTER_ROWS = [
      { key: "allowUsers", label: "只回这些人", hint: "uid 或昵称，逗号分隔。空 = 不限" },
      { key: "denyUsers", label: "不回这些人", hint: "黑名单，优先于白名单" },
      { key: "allowForums", label: "只回这些板块", hint: "板块 id 或名字。空 = 不限" },
      { key: "denyForums", label: "不回这些板块", hint: "黑名单" },
      { key: "allowTopics", label: "只回这些帖子", hint: "帖子 id 或链接。空 = 不限" },
      { key: "denyTopics", label: "不回这些帖子", hint: "黑名单" },
    ];

    function SourcePanel({ def, cfg, setCfg, disabled, onPickSections }) {
      const src = getPath(cfg, ["listen", def.key]) || {};
      const set = (path, value) => setCfg((c) => setPath(c, ["listen", def.key, ...path], value));
      const itemsArr = (Array.isArray(src.items) ? src.items : []).map((it) =>
        typeof it === "string" ? it : [it.id, it.title].filter(Boolean).join(" "));
      const forumsArr = (Array.isArray(src.forums) ? src.forums : []).map((it) =>
        typeof it === "string" ? it : [it.id, it.title].filter(Boolean).join(" "));
      const toItems = (arr) => arr.map((line) => {
        const sp = line.search(/\s/);
        return sp < 0 ? { id: line, title: "" } : { id: line.slice(0, sp), title: line.slice(sp + 1).trim() };
      });

      // 范围语义说明：这个源的开关和清单是「与」关系，两个都满足才扫。
      // 关掉开关 = 这个源完全不参与；开关开着但清单空 = 没有地方可扫，同样什么都不出。
      const scopeNote = def.noItems
        ? !src.enabled
          ? "关着：不去读消息中心的通知，别人的 @ 一条都收不到"
          : "开着：每轮读一次消息中心的「@我的」，有新 @ 就回。这里没有要填的东西"
        : !src.enabled
          ? "关着：这个源完全不参与，一条都不扫"
          : itemsArr.length === 0
            ? "开着但清单是空的：没有可扫的地方，实际上什么都不扫。要让它自己出去找帖，去开「自动刷论坛」"
            : "开着，扫这 " + itemsArr.length + " 个地方";

      return h("div", null,
        h("div", { className: "hks-note", style: { paddingBottom: "2px" } }, scopeNote),
        def.noItems ? null : h(Row, { label: def.itemsLabel, hint: def.itemsHint, block: true },
          h("textarea", {
            className: "hks-ta", disabled, placeholder: def.itemsPh, value: itemsArr.join("\n"),
            onChange: (e) => set(["items"], toItems(e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean))),
          })),

        // at.forums 只做限制、不扩大扫描范围（collect() 根本不读它），所以标题不能写成「额外盯的板块」。
        def.forums ? h(Row, { label: "只在这些板块里应 @", hint: "留空 = 不限板块。\n填了以后，只有这些板块里的 @ 才算数；它不会扩大扫描范围——扫哪儿由上面的「板块」和「帖子」决定", block: true },
          h("textarea", {
            className: "hks-ta", disabled, placeholder: "23064", value: forumsArr.join("\n"),
            onChange: (e) => set(["forums"], toItems(e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean))),
          })) : null,

        (def.extra || []).map((x) =>
          h(SwRow, {
            key: x.path.join("."), label: x.label, hint: x.hint,
            on: !!getPath(src, x.path), onChange: (v) => set(x.path, v), disabled,
          })),

        def.key === "forum" && onPickSections
          ? h("div", { className: "hks-rowbtns", style: { paddingTop: "4px" } },
              h("button", { type: "button", className: "hks-link", onClick: onPickSections, disabled }, "查板块 ID"))
          : null,

        h(More, { label: "这个源专属的白名单 / 黑名单" },
          FILTER_ROWS.map((f) =>
            h(Row, { key: f.key, label: f.label, hint: f.hint },
              h(ListInput, {
                value: Array.isArray(src[f.key]) ? src[f.key] : [],
                onChange: (v) => set([f.key], v),
                placeholder: "空 = 不限",
                disabled,
              })))));
    }

    /**
     * 内容安全卡。
     * 三道闸：入站（别人写的，命中不接话、**不调模型** → 零 token）、
     * 出站（模型写的，命中不发）、配置（破甲提示词 / 破甲模型，保存时拒）。
     * 这一卡自己的按钮不走整份配置保存：试一句和看词表都是一次性请求。
     */
    function SafetyPanel({ cfg, setCfg, sys, locked, busy, setBusy }) {
      const S = cfg.safety || {};
      const [probe, setProbe] = useState("");
      const [probeOut, setProbeOut] = useState("");
      const [msg, setMsg] = useState("");
      const set = (k, v) => setCfg((c) => setPath(c, ["safety", k], v));

      const runProbe = async () => {
        const text = String(probe || "").trim();
        if (!text) { setProbeOut("先写一句要试的话"); return }
        setBusy("safety");
        setProbeOut("");
        try {
          const r = await fetch(API + "/safety", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "test", text }),
          });
          const j = await r.json();
          if (!j.ok) { setProbeOut("✗ " + (j.error || "试词失败")); return }
          const line = (label, x) => label + (x.blocked ? "拦下（" + x.count + " 处）" : "放行");
          const p = j.platform || {};
          const pLine = !p.configured
            ? (p.skipped === "off" ? "平台闸：没开（跳过）" : "平台闸：没配（跳过）")
            : p.error ? "平台闸：接口不可用（" + p.error + "）"
            : p.blocked ? "平台闸：拦下（" + p.count + " 处）"
            : "平台闸：通过";
          setProbeOut([
            line("入站闸：", j.inbound),
            line("出站闸：", j.outbound),
            pLine,
            // 只报条数，不回显命中的词（回显等于给出一份「换哪个词能过」的清单）
            "破甲词：" + (j.jailbreak.blocked ? "命中 " + (j.jailbreak.count || 0) + " 处" : "没有"),
          ].join("　"));
        } catch (e) { setProbeOut("✗ " + String(e.message || e)) }
        finally { setBusy(""); }
      };

      const clearSaid = async () => {
        if (!askSure("清空复读台账？（之后同一句话可以再发一次）")) return;
        setBusy("safety");
        try {
          const r = await fetch(API + "/safety", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "clearSaid" }),
          });
          const j = await r.json();
          setMsg(j.ok ? "✓ 已清空复读台账" : "✗ " + (j.error || "清空失败"));
        } catch (e) { setMsg("✗ " + String(e.message || e)) }
        finally { setBusy(""); }
      };

      const dedupe = (sys && sys.dedupe) || { total: 0, inWindow: 0, days: 0 };
      const on = S.enabled !== false;
      // 平台预检那几项在 FIELDS 里是 tier 9（不进通用渲染），这里按 path 取出来自己排
      const mwFields = {};
      for (const f of FIELDS) {
        if (f.path[0] === "safety" && f.path[1] === "maskword") mwFields[f.path[2]] = f;
      }

      return h(Card, { sec: "safety", title: "内容安全",
        sub: "三类违禁词各一道闸：别人写的命中就不接话（不调模型），模型写的命中就不发；破甲词与破甲模型在保存时就拒。",
        badge: { s: "ok", t: "强制开启" },
        right: h(Sw, { on: true, disabled: true }),
      },
        [
          h("div", { key: "tip", className: "hks-note", style: { paddingBottom: "4px" } },
            "这张卡没有关闭档位：三类违禁词与两道闸都强制开启。命中的一律回固定话术，那句话由程序直接发。"),

          h(SwRow, { key: "pol", label: "国家 / 政治类不接",
            hint: "政治口号、分裂主张、涉政事件与人名相关的词。命中①不接话②模型写出来也不发。\n论坛里聊「政治」这个词本身不会命中 —— 拦的是具体的主张与事件，不是词面像。\n强制开启，没有关闭档位。",
            on: true, disabled: true }),
          h(SwRow, { key: "sex", label: "色情类不接",
            hint: "色情交易、器官、性行为的露骨词，以及 porn / nsfw / hentai 这类英文词。\n强制开启，没有关闭档位。",
            on: true, disabled: true }),
          h(SwRow, { key: "vio", label: "血腥暴力类不接",
            hint: "虐杀、分尸、自杀方式、爆炸物制作这类词。\n注意：游戏里的「屠龙宝刀」「血洗排行榜」会被误伤，可以把词填进下面的「例外词」。\n强制开启，没有关闭档位。",
            on: true, disabled: true }),

          h("div", { key: "gh", className: "hks-h4" }, "两道闸"),
          h(SwRow, { key: "in", label: "别人写的命中就不接话",
            hint: "这一道在调用模型之前判：命中就跳过、回固定话术，一次模型都不调。\n强制开启，没有关闭档位。",
            on: true, disabled: true }),
          h(SwRow, { key: "out", label: "模型写的命中就不发",
            hint: "这一道在模型生成之后判：真的写出来了就整条不发。\n强制开启，没有关闭档位。",
            on: true, disabled: true }),

          // 平台词表预检：本地词表之外，再问一次快爆自己的接口
          h("div", { key: "mwh", className: "hks-h4" }, "平台词表预检"),
          h("div", { key: "mwn", className: "hks-note" },
            "发之前再问一次快爆自己的敏感词接口：本地词表是插件自己攒的，平台词表才是真正会拦你的那一份。\n该功能需要联系快爆商务获取 appid 与密钥；没配时这一步自动跳过。"),
          mwFields.enabled ? h(Field, { key: "mw-en", field: mwFields.enabled, cfg, setCfg, disabled: locked }) : null,
          (S.maskword && S.maskword.enabled === true)
            ? h("div", { key: "mwb" },
                mwFields.appid ? h(Field, { key: "mw-appid", field: mwFields.appid, cfg, setCfg, disabled: locked }) : null,
                mwFields.key ? h(Field, { key: "mw-key", field: mwFields.key, cfg, setCfg, disabled: locked }) : null,
                h(More, { key: "mwadv" },
                  mwFields.level ? h(Field, { key: "mw-level", field: mwFields.level, cfg, setCfg, disabled: locked }) : null))
            : null,

          h(Row, { key: "rt", label: "命中后回哪一句", block: true,
            hint: "这句话由程序直接发出去，不经过模型。固定文本，不可修改。" },
            h("input", { className: "hks-in", value: "识别到违规内容无法生成回复", disabled: true, readOnly: true })),

          h("div", { key: "sh", className: "hks-h4" }, "试一句"),
          h("div", { key: "probe", className: "hks-stack" },
            h("input", {
              className: "hks-in", value: probe, disabled: locked,
              placeholder: "贴一句想试的话，看会被哪道闸拦",
              onChange: (e) => setProbe(e.target.value),
            }),
            h("div", { className: "hks-rowbtns", style: { justifyContent: "flex-start" } },
              h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled: locked || busy === "safety", onClick: runProbe },
                busy === "safety" ? "检查中…" : "试一句"))),
          probeOut ? h("div", { key: "po", className: "hks-note" }, probeOut) : null,
          h("div", { key: "dh", className: "hks-h4" }, "复读查重"),
          h("div", { key: "ds", className: "hks-note" },
            "台账里 " + (dedupe.total || 0) + " 条，最近 " + (dedupe.days || 0) + " 天窗口内 " + (dedupe.inWindow || 0) + " 条。同一句（或很像的一句）在窗口内说过就不再发 —— 复读比频率更容易被认出是机器。"),
          h("div", { key: "db", className: "hks-rowbtns", style: { justifyContent: "flex-start", paddingTop: "4px" } },
            h("button", { type: "button", className: "hks-btn", "data-v": "ghost", "data-sz": "sm", disabled: locked || busy === "safety", onClick: clearSaid }, "清空复读台账")),
          msg ? h("div", { key: "m", className: msg.indexOf("✓") === 0 ? "hks-ok" : "hks-err" }, msg) : null,

          h(More, { key: "adv" },
            h(Row, { label: "自加违禁词", block: true, hint: "逗号分隔。你加的词和内置词一样拦，且两边都适用（入站 + 出站）。" },
              h(ListInput, { value: S.extraWords || [], disabled: locked, placeholder: "例如：某个游戏外挂名",
                onChange: (v) => set("extraWords", v) })),
            h(Row, { label: "例外词（不拦）", block: true, hint: "逗号分隔。游戏里的误伤词填这里，例如「尸体」「血洗」这种在游戏语境里正常的词。" },
              h(ListInput, { value: S.allowWords || [], disabled: locked, placeholder: "例如：屠龙宝刀",
                onChange: (v) => set("allowWords", v) })),
            h(SwRow, { label: "出站命中时也回那句话术",
              hint: "默认关：模型自己写跑偏时宁可不发，也别回一句。\n开着 = 和入站一样回固定话术。",
              on: S.replyOnOutbound === true, disabled: locked, onChange: (v) => set("replyOnOutbound", v) })),
        ])
    }

    /* ───────────────── 主组件 ───────────────── */

    /** 保存状态的三态文案。没有保存按钮，这行就是用户唯一能看到的确认。 */
    const SAVE_TEXT = {
      idle: { cls: "hks-note", text: "改动会自动保存" },
      saving: { cls: "hks-note", text: "保存中…" },
      saved: { cls: "hks-ok", text: "✓ 已保存" },
      failed: { cls: "hks-err", text: "✗ 保存失败，改一下会重试" },
    };

    /** @ 触发口径。和 tools/lib/trigger.mjs 的 TRIGGER_MODES 一一对应。 */
    const TRIGGER_OPTS = [
      { key: "both", t: "两种都认" },
      { key: "rich", t: "只认真 @" },
      { key: "plain", t: "只认文字 @" },
    ];

    const MODES = [
      { key: "reply", t: "只回 @", s: "有人喊她才说话" },
      { key: "both", t: "两个都要", s: "回帖 + 刷帖都开" },
      { key: "browse", t: "只刷不发", s: "自己翻帖、写日报" },
      { key: "off", t: "先关着", s: "装好，不自动跑" },
      { key: "test", t: "测试模式", s: "仅供测试 · 最小限制" },
    ];
    const TEST_NOTE = "仅供测试使用，日常无需开启；选择此模式后，功能为最大宽度，也就是最小限制，方便测试，无需一一配置。";

    const ACT_LEVEL = { pass: "通过", warn: "注意", fail: "失败", skip: "跳过", info: "" };
    const ACT_FILTERS = [
      { key: "", t: "全部" },
      { key: "run", t: "自动运行" },
      { key: "manual", t: "手动预演" },
      { key: "selftest", t: "自检" },
    ];
    const hhmm = (iso) => {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "--:--";
      const p2 = (n) => String(n).padStart(2, "0");
      return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
    };

    /**
     * 运行日志 + 一键自检。
     * 日志来自服务端 /activity（插件每次收 @、回评论、扫论坛、写日报都会记一条）；
     * 自检走 /selftest：只读 + 预演，不发内容、不动调度、不改配置，所以和测试模式互不影响。
     */
    function ActivityPanel({ testOn, sys, risk, locked, onDone }) {
      const [items, setItems] = useState([]);
      const [kinds, setKinds] = useState({});
      const [src, setSrc] = useState("");
      const [report, setReport] = useState(null);
      const [running, setRunning] = useState(false);
      const [msg, setMsg] = useState("");
      const alive = useRef(true);

      const load = useCallback(async (s) => {
        try {
          const q = "?limit=150" + (s ? "&src=" + encodeURIComponent(s) : "");
          const r = await fetch(API + "/activity" + q);
          const j = await r.json();
          if (!alive.current || !j || !j.ok) return;
          setItems(Array.isArray(j.items) ? j.items : []);
          if (j.kinds && typeof j.kinds === "object") setKinds(j.kinds);
        } catch {}
      }, []);

      useEffect(() => {
        alive.current = true;
        load(src);
        const t = setInterval(() => load(src), 15000);
        return () => { alive.current = false; clearInterval(t); };
      }, [load, src]);

      const clearLog = useCallback(async () => {
        if (typeof window !== "undefined" && window.confirm && !window.confirm("清空全部运行日志？（不影响已回复记录和配置）")) return;
        try {
          const r = await fetch(API + "/activity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
          const j = await r.json();
          setMsg(j.ok ? "✓ 已清空" : (j.error || "清空失败"));
        } catch (e) { setMsg(String(e.message || e)); }
        setReport(null);
        load(src);
        if (onDone) onDone();
      }, [load, src, onDone]);

      const runTest = useCallback(async () => {
        setRunning(true); setMsg(""); setReport(null);
        try {
          const r = await fetch(API + "/selftest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          const j = await r.json();
          if (j.ok && j.report) setReport(j.report);
          else setMsg(j.error || "自检失败");
        } catch (e) { setMsg(String(e.message || e)); }
        finally {
          if (alive.current) setRunning(false);
          load(src);
          if (onDone) onDone();
        }
      }, [load, src, onDone]);

      const c = (sys && sys.activity) || {};
      const n = (k) => Number(c[k]) || 0;
      const busyTest = running || !!(sys && sys.test && sys.test.selfTestRunning);
      const stat = (label, k, s) => h("span", { className: "hks-pill", key: k },
        h("span", { className: "hks-dot", "data-s": n(k) ? s || "ok" : "" }), label + " ", h("b", null, String(n(k))));
      const sum = report && report.summary ? report.summary : null;
      // 额度：算的是请求次数（每次向快爆发一个请求记 1 次），和上面的「扫描论坛」「读通知」轮次不是一回事
      const tr = (sys && sys.traffic) || {};
      const R = risk || {};
      const quota = (label, used, cap) => {
        const u = Number(used) || 0, m = Number(cap) || 0;
        const s = !m ? "" : u >= m ? "bad" : u >= m * 0.8 ? "warn" : "ok";
        return h("span", { className: "hks-pill", key: label },
          h("span", { className: "hks-dot", "data-s": s }), label + " ", h("b", null, u + (m ? " / " + m : "")));
      };

      return h(Card, {
        id: "activity",
        title: "运行日志",
        sub: "插件做过的每件事都记在这里；今日次数只算真实运行，不含预演和自检",
        right: h("div", { className: "hks-rowbtns" },
          h("button", { type: "button", className: "hks-link", onClick: () => load(src) }, "刷新"),
          h("button", { type: "button", className: "hks-link", onClick: clearLog, disabled: busyTest }, "清空")),
      },
        h("div", { className: "hks-chips" },
          stat("收到 @", "at"),
          stat("回复评论", "reply"),
          stat("扫描论坛", "forum"),
          stat("读通知", "notice"),
          stat("回帖轮次", "listen"),
          stat("刷帖轮次", "browse"),
          stat("日报", "digest"),
          stat("发帖", "post"),
          stat("叫醒", "wake"),
          stat("失败", "fail", "bad")),
        h("div", { className: "hks-chips", style: { marginTop: "6px" } },
          quota("读请求·本小时", tr.readHour, R.readHourly),
          quota("读请求·今天", tr.readDay, R.readDaily),
          quota("写请求·本小时", tr.writeHour, R.writeHourly),
          quota("写请求·今天", tr.writeDay, R.writeDaily)),
        h("div", { className: "hks-note", style: { marginTop: "4px" } },
          "上面一排是做了几轮、几件事；这一排是向快爆发了多少个请求（安全阀额度按这个算）。一轮回帖通常要发好几个请求。"),

        h("div", { className: "hks-row hks-row--block" },
          h("div", { className: "hks-l" },
            h("span", { className: "hks-lbl" }, "一键自检"),
            h("span", { className: "hks-note" },
              "逐项检查登录、@ 通知、@ 识别、AI、扫论坛、读帖子、自动回帖、刷帖日报发帖、写额度、安全阀、叫醒、调度器。全程只读 + 预演，不发任何内容、不改配置、不动正在跑的调度"
                + (testOn ? "；测试模式开着也能放心点，两边互不影响。" : "。"))),
          h("div", { className: "hks-c" },
            h("button", { type: "button", className: "hks-btn", "data-sz": "sm", onClick: runTest, disabled: busyTest || locked },
              busyTest ? "自检中…" : "一键自检"))),

        sum
          ? h("div", null,
              h("div", { className: sum.fail ? "hks-err" : "hks-ok" },
                (sum.fail ? "有 " + sum.fail + " 项失败" : "全部能用") + "：通过 " + (sum.pass || 0) + "，注意 " + (sum.warn || 0)
                  + "，失败 " + (sum.fail || 0) + "，跳过 " + (sum.skip || 0) + "（用时 " + Math.round((Number(report.ms) || 0) / 100) / 10 + " 秒）"),
              h("div", { className: "hks-steps" }, (report.steps || []).map((s, i) =>
                h("div", { className: "hks-step", key: i },
                  h("span", { className: "hks-badge", "data-s": s.level === "pass" ? "ok" : s.level === "skip" ? "" : "warn" }, ACT_LEVEL[s.level] || s.level || ""),
                  h("b", null, s.name || ""),
                  h("span", { className: s.level === "fail" ? "hks-err" : "hks-note" }, s.detail || "")))))
          : null,
        msg ? h("div", { className: msg.startsWith("✓") ? "hks-ok" : "hks-err" }, msg) : null,

        h("div", { className: "hks-seg", style: { marginTop: "10px" } }, ACT_FILTERS.map((f) =>
          h("button", { type: "button", key: f.key || "all", "data-on": src === f.key ? 1 : 0, onClick: () => setSrc(f.key) }, f.t))),
        items.length
          ? h("div", { className: "hks-acts" }, items.map((e, i) =>
              h("div", { className: "hks-act", key: (e.at || "") + i, "data-l": e.ok === false ? "fail" : e.level || "info" },
                h("time", null, hhmm(e.at)),
                h("b", null, kinds[e.kind] || e.kind || ""),
                h("span", null, (e.src === "manual" ? "［预演］" : e.src === "selftest" ? "［自检］" : "") + (e.text || "")))))
          : h("div", { className: "hks-note", style: { marginTop: "8px" } }, "还没有记录。开启自动回帖 / 刷帖，或点「一键自检」后这里会出现。"));
    }

    /** 已登录：账号摘要 + 换号 / 退出。没登录时不渲染，直接给扫码框。 */
    /**
     * 浏览记录：她真读过 / 回过 / 跳过的帖，一条一行。
     * 三个时间（发布 / 改过 / 最后回复）由服务端 /history 算成人话，这里只排版。
     */
    function HistoryPanel({ sys, locked }) {
      const [items, setItems] = useState([]);
      const [counts, setCounts] = useState({});
      const [msg, setMsg] = useState("");
      // 卡片的箭头是唯一开关：认存储里的状态，展开即读
      const [open, setOpen] = useState(!isClosed("history"));
      const [loading, setLoading] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const r = await fetch(API + "/history?limit=10");
          const j = await r.json();
          if (!alive.current || !j || !j.ok) return;
          setItems(Array.isArray(j.items) ? j.items : []);
          if (j.counts && typeof j.counts === "object") setCounts(j.counts);
        } catch {}
        finally { if (alive.current) setLoading(false); }
      }, []);

      useEffect(() => {
        alive.current = true;
        if (!open) return () => { alive.current = false; };
        load();
        const t = setInterval(load, 20000);
        return () => { alive.current = false; clearInterval(t); };
      }, [load, open]);

      const clearAll = useCallback(async () => {
        if (typeof window !== "undefined" && window.confirm && !window.confirm("清空浏览记录？（不影响配置和已回帖记录）")) return;
        try {
          const r = await fetch(API + "/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
          const j = await r.json();
          setMsg(j.ok ? "✓ 已清空" : (j.error || "清空失败"));
        } catch (e) { setMsg(String(e.message || e)); }
        setItems([]);
        setCounts({});
      }, []);

      const c = (sys && sys.history) || counts || {};
      const n = (k) => String(Number(c[k]) || 0);
      const pill = (label, k) => h("span", { className: "hks-pill", key: k },
        h("span", { className: "hks-dot", "data-s": Number(c[k]) ? "ok" : "" }), label + " ", h("b", null, n(k)));

      const rows = items.map((it, i) => h("div", {
        key: String(it.topicId) + ":" + it.action + ":" + i,
        style: { padding: "6px 0", borderTop: "1px solid rgba(127,127,127,.18)" },
      },
        h("div", null,
          h("b", null, it.actionText || it.action || ""), " ",
          h("span", null, it.title || "(无标题)"),
          it.topicId ? h("span", { className: "hks-note" }, "　#" + it.topicId) : null),
        h("div", { className: "hks-note" },
          (it.sectionTitle || it.sectionId || "—") + " · " + (it.nickname || it.uid || "—") +
          " · 发布 " + (it.publishedText || "—") +
          " · 修改 " + (it.editedText || "无") +
          " · 最近回复 " + (it.repliedText || "—") +
          (it.why ? " · " + it.why : ""))));

      return h(Card, {
        id: "history",
        title: "浏览记录",
        sub: "她真读过、回过、跳过的帖。每条带发布时间、修改时间、最近回复时间和这次的动作",
        onToggle: (closedNow) => setOpen(!closedNow),
        right: h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
          open
            ? h("button", { type: "button", className: "hks-link", disabled: locked || loading, onClick: load }, loading ? "读取中…" : "刷新")
            : null,
          open && items.length ? h("button", { type: "button", className: "hks-link", disabled: locked, onClick: clearAll }, "清空") : null),
      },
        h("div", { className: "hks-chips" },
          pill("已回复", "reply"), pill("写进日报", "digest"), pill("跳过", "skip"), pill("今天合计", "total")),
        msg ? h("div", { className: "hks-note" }, msg) : null,
        open
          ? (items.length
              ? h("div", { className: "hks-hist" }, rows)
              : h("div", { className: "hks-note" }, "还没有记录。她跑过一轮回帖或刷帖之后，这里会按帖记下来。"))
          : h("div", { className: "hks-note" }, "展开后读最近 10 条，超出可在框内滚动。收起就不占版面，也不发请求。"));
    }

    function AccountBox({ acc, disabled, onSwitch, onLogout, busy }) {
      const name = acc.nickname || "（没昵称）";
      return h("div", { className: "hks-acct" },
        h("div", { className: "hks-ava", "aria-hidden": true }, String(name).slice(0, 1)),
        h("div", { className: "hks-acct-m" },
          h("span", { className: "hks-acct-n" }, name),
          h("span", { className: "hks-acct-s" }, "uid " + (acc.uid || "-") + " · " + (acc.hasPauth ? "能读能写（回帖、发帖）" : "只能读，重新登录一次才能发"))),
        h("div", { className: "hks-rowbtns" },
          h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled, onClick: onSwitch }, "换个号"),
          h("button", { type: "button", className: "hks-btn", "data-v": "ghost", "data-sz": "sm", disabled, onClick: onLogout }, busy ? "退出中…" : "退出登录")));
    }

    /**
     * 页头身份条：账号 / 人设 / 线路 三个下拉，点一下换掉。
     * 这里只管"换"，改备注 / 加号 / 删人设放在各自的卡片里 —— 那边的上下文更长。
     */
    function IdentityBar({ profiles, busy, msg, onAction }) {
      const [open, setOpen] = useState("");
      if (!profiles) return null;
      const accs = profiles.accounts || [];
      const ps = profiles.personas || [];
      const lines = profiles.lines || [];
      const act = profiles.active || {};
      const curAcc = accs.find((a) => a.id === act.account) || null;
      const curP = ps.find((p) => p.id === act.persona) || ps[0] || null;
      const curL = lines.find((l) => l.id === act.line) || lines[0] || null;
      const go = (action, id) => { setOpen(""); onAction({ action, id }); };
      const item = (key, title, sub, on, run, disabled) => h("button", {
        key, type: "button", className: "hks-idmi", "data-on": on ? 1 : 0, disabled: !!busy || !!disabled,
        onClick: run,
      }, title, sub ? h("span", null, sub) : null);
      const pill = (key, label, text, state) => h("button", {
        type: "button", className: "hks-idp", "data-on": open === key ? 1 : 0, disabled: !!busy,
        "aria-expanded": open === key ? "true" : "false",
        onClick: () => setOpen(open === key ? "" : key),
      }, state ? h("span", { className: "hks-dot", "data-s": state }) : null,
        h("span", { className: "hks-idt" }, label), h("b", null, text));
      const panel = (kind) => (open === kind
        ? h("div", { className: "hks-idm" },
            kind === "account"
              ? (accs.length
                  ? accs.map((a) => item("a" + a.id, (a.label || a.id) + (a.active ? " · 当前" : ""), a.present ? "" : "需重新登录", a.active, () => go("switchAccount", a.id), a.active || !a.present))
                  : h("div", { className: "hks-note" }, "还没有号：在下面「登录账号」里扫码"))
              : null,
            kind === "persona" ? ps.map((p) => item("p" + p.id, p.label + (p.id === act.persona ? " · 当前" : ""), p.name, p.id === act.persona, () => go("switchPersona", p.id), p.id === act.persona)) : null,
            kind === "line" ? lines.map((l) => item("l" + l.id, l.name + (l.id === act.line ? " · 当前" : ""), l.hasKey ? (l.model || "") : "无密钥", l.id === act.line, () => go("switchLine", l.id), l.id === act.line || !l.hasKey)) : null,
            msg ? h("div", { className: "hks-idmsg" }, msg) : null)
        : null);
      return h("div", { className: "hks-id" },
        pill("account", "账号", curAcc ? (curAcc.nickname || curAcc.label || curAcc.id) : "未登录", curAcc ? (curAcc.present ? "ok" : "bad") : "bad"),
        pill("persona", "人设", curP ? curP.label : "—", "ok"),
        pill("line", "AI 线路", curL ? curL.name : "未配置", curL && curL.hasKey ? "ok" : "bad"),
        panel("account"), panel("persona"), panel("line"));
    }

    /** 账号清单：多个号一屏，切换 / 改备注 / 移除。加号仍走上面的扫码框（扫码成功即注册）。 */
    function AccountList({ profiles, busy, onAction, onRetire }) {
      const [edit, setEdit] = useState("");
      const [draft, setDraft] = useState("");
      const accs = (profiles && profiles.accounts) || [];
      if (!accs.length) return null;
      return h("div", { className: "hks-accl" },
        h("div", { className: "hks-h4" }, "我的号（" + accs.length + "）"),
        accs.map((a) => h("div", { key: a.id, className: "hks-accl-i", "data-on": a.active ? 1 : 0 },
          h("span", { className: "hks-dot", "data-s": a.present ? "ok" : "bad" }),
          h("span", { className: "hks-accl-n" }, a.label || a.id),
          h("span", { className: "hks-accl-s" }, "uid " + a.id + (a.active ? " · 当前在用" : "") + (a.present ? "" : " · 需要重新登录")),
          edit === a.id
            ? h("input", { className: "hks-in hks-accl-in", value: draft, disabled: !!busy, "aria-label": "账号备注", onChange: (e) => setDraft(e.target.value) })
            : null,
          h("div", { className: "hks-rowbtns" },
            edit === a.id
              ? h("button", { type: "button", className: "hks-btn", "data-v": "primary", "data-sz": "sm", disabled: !!busy, onClick: () => { onAction({ action: "labelAccount", id: a.id, label: draft }); setEdit("") } }, "保存备注")
              : h("button", { type: "button", className: "hks-btn", "data-v": "ghost", "data-sz": "sm", disabled: !!busy, onClick: () => { setEdit(a.id); setDraft(a.label || a.id) } }, "改备注"),
            a.active ? null : h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled: !!busy || !a.present, onClick: () => onAction({ action: "switchAccount", id: a.id }) }, "切到这个号"),
            a.active ? null : h("button", { type: "button", className: "hks-btn", "data-v": "ghost", "data-sz": "sm", disabled: !!busy, onClick: () => onRetire(a) }, "移除")))));
    }

    /** 人设选择行：下拉 + 新建 / 复制 / 改名 / 删除。下面整张卡改的都是当前这个人设。 */
    function PersonaBar({ profiles, busy, onAction }) {
      const [edit, setEdit] = useState(false);
      const [draft, setDraft] = useState("");
      const ps = (profiles && profiles.personas) || [];
      if (!ps.length) return null;
      const cur = ps.find((p) => p.id === (profiles.active || {}).persona) || ps[0];
      const btn = (key, text, run, opts) => h("button", Object.assign({
        key, type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled: !!busy,
        onClick: run,
      }, (opts && opts.variant) ? { "data-v": opts.variant } : null), text);
      return h("div", { className: "hks-pbar" },
        h("span", { className: "hks-lbl" }, "当前人设"),
        h("select", {
          className: "hks-sel", value: cur.id, disabled: !!busy, "aria-label": "切换人设",
          onChange: (e) => onAction({ action: "switchPersona", id: e.target.value }),
        }, ps.map((p) => h("option", { key: p.id, value: p.id }, p.label + "（" + p.name + "）"))),
        edit
          ? h("span", { className: "hks-inl" },
              h("input", { className: "hks-in", value: draft, disabled: !!busy, "aria-label": "人设备注", onChange: (e) => setDraft(e.target.value) }),
              btn("save", "保存备注", () => { onAction({ action: "renamePersona", id: cur.id, label: draft }); setEdit(false) }, { variant: "primary" }))
          : btn("rename", "改备注", () => { setEdit(true); setDraft(cur.label) }),
        btn("add", "新建", () => onAction({ action: "addPersona", label: "人设 " + (ps.length + 1) })),
        btn("dup", "复制", () => onAction({ action: "duplicatePersona", id: cur.id })),
        ps.length > 1 ? btn("del", "删除", () => onAction({ action: "removePersona", id: cur.id }), { variant: "ghost" }) : null);
    }

    /** 板块值统一成 {id,title}：老配置里是纯 id 字符串。 */
    const secOf = (x) => (x && typeof x === "object" ? { id: String(x.id || ""), title: String(x.title || "") } : { id: String(x || ""), title: "" });

    /**
     * 板块选择器。multi=true 选多个（读哪些板块），否则只选一个（发到哪个板块）。
     * 板块目录按需拉（点「选板块」才出网），找不到的板块可以直接填 ID。
     */
    function SectionPicker({ multi, value, onChange, disabled, catalog, onLoad, loading, empty }) {
      const [open, setOpen] = useState(false);
      const [q, setQ] = useState("");
      const list = (multi ? (Array.isArray(value) ? value : []) : (value && value.id ? [value] : [])).map(secOf).filter((x) => x.id);
      const titleOf = (x) => x.title || ((catalog || []).find((c) => String(c.id) === x.id) || {}).title || "";
      const has = (id) => list.some((x) => x.id === String(id));
      const pick = (sec) => {
        const v = { id: String(sec.id), title: String(sec.title || "") };
        if (!multi) { onChange(v); setOpen(false); return; }
        onChange(has(v.id) ? list.filter((x) => x.id !== v.id) : list.concat([v]));
      };
      const drop = (id) => onChange(multi ? list.filter((x) => x.id !== id) : { id: "", title: "" });
      const kw = q.trim();
      const rows = (catalog || []).filter((c) => !kw || String(c.title).includes(kw) || String(c.id) === kw || String(c.group || "").includes(kw)).slice(0, 80);
      const manual = /^\d{1,12}$/.test(kw) && !rows.some((c) => String(c.id) === kw);
      return h("div", { className: "hks-stack" },
        h("div", { className: "hks-tags" },
          list.length
            ? list.map((x) => h("span", { key: x.id, className: "hks-tag" }, (titleOf(x) || "板块") + " · " + x.id,
                h("button", { type: "button", disabled, "aria-label": "去掉", onClick: () => drop(x.id) }, "×")))
            : h("span", { className: "hks-note" }, empty || "还没选"),
          h("button", {
            type: "button", className: "hks-link", disabled,
            onClick: () => { const n = !open; setOpen(n); if (n && !catalog && onLoad) onLoad(); },
          }, open ? "收起" : multi ? "选板块" : (list.length ? "换一个" : "选板块"))),
        open ? h("div", { className: "hks-pick" },
          h("input", { className: "hks-in", value: q, placeholder: "搜板块名，或直接填板块 ID", disabled, onChange: (e) => setQ(e.target.value) }),
          loading ? h("span", { className: "hks-note" }, "拉板块目录中…") : null,
          !loading && catalog && !rows.length && !manual ? h("span", { className: "hks-note" }, "没找到") : null,
          manual ? h("button", { type: "button", className: "hks-link", disabled, onClick: () => { pick({ id: kw, title: "" }); setQ(""); } }, (multi ? "加上" : "用") + "板块 ID " + kw) : null,
          rows.length ? h("div", { className: "hks-pick-l" }, rows.map((c) => h("button", {
            key: c.id, type: "button", disabled, "data-on": has(c.id) ? 1 : 0, onClick: () => pick(c),
          }, (has(c.id) ? "✓ " : "") + c.title, h("span", null, c.discuss ? "讨论 " + c.discuss : String(c.id))))) : null)
          : null);
    }

    function HykbScrollSection() {
      const [cfg, setCfg] = useState(null);
      const [sys, setSys] = useState(null);
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [note, setNote] = useState("");
      const [saveState, setSaveState] = useState("idle");
      /** 最近一次「被安全闸拒存」的详情：{ error, hits[], at }。非空时页面顶部挂一条红条。 */
      const [blocked, setBlocked] = useState(null);
      /** blocked 的同步镜像：saveIdentity 要在 await 之后立刻判断"刚才那次被拒了吗"，
          state 更新是异步的，读不到最新值。 */
      const blockedRef = useRef(null);
      /** 人设正文的最新值：flush 提交时要带上（服务端据此判断本次是否动了人设）。 */
      const personaTextRef = useRef("");

      /** 设置 blocked 时同步维护 ref（await 之后读 state 拿到的是旧值）。 */
      const markBlocked = useCallback((v) => { blockedRef.current = v; setBlocked(v) }, []);
      const [warn, setWarn] = useState("");
      const [busy, setBusy] = useState("");
      const [ck, setCk] = useState({ uid: "", Pauth: "", Uauth: "", nickname: "" });
      const [ckMsg, setCkMsg] = useState("");
      const [tokMsg, setTokMsg] = useState("");
      const [qrActive, setQrActive] = useState(false);
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      // 默认停在 @ 我通知：它是唯一默认开着、且不用填任何东西的源
      const [tab, setTab] = useState("atme");
      const [secList, setSecList] = useState(null);
      // 设置项搜索：输入即时过滤，点结果跳过去并把那一行闪一下
      const [q, setQ] = useState("");
      const [findMsg, setFindMsg] = useState("");
      // 已登录时默认只显示账号摘要；点「换个号」才展开扫码框
      const [switching, setSwitching] = useState(false);
      // 全站板块目录：板块选择器按需拉，两个选择器共用一份
      const [catalog, setCatalog] = useState(null);
      const [catLoading, setCatLoading] = useState(false);
      // 「试读一批评价」的结果（只读，不进日报，不动调度）
      const [gamesPreview, setGamesPreview] = useState(null);
      // 中转站密钥：明文只留在内存里，随下一次保存 POST 一次性送上去（服务端只回 hasKey），成功后清空。
      const [relayKeys, setRelayKeys] = useState({});
      const relayKeysRef = useRef({});
      /** cfg 的当前值。自动保存是纯计算，不能塞进 setState 的 updater。 */
      const cfgRef = useRef(null);

      useEffect(() => {
        if (document.querySelector('style[data-dsh-css="' + CSS_TAG + '"]')) return;
        const el = document.createElement("style");
        el.setAttribute("data-dsh-css", CSS_TAG);
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(API + "/settings");
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "读取失败"); return; }
          cfgRef.current = j.config;
          setCfg(j.config);
        } catch (e) { setErr(String(e.message || e)); }
      }, []);

      const probe = useCallback(async (quiet) => {
        if (!quiet) setBusy("status");
        try {
          const r = await fetch(API + "/status");
          const j = await r.json();
          if (j.ok) setSys(j);
          else if (!quiet) setErr(j.error || "状态读取失败");
        } catch (e) { if (!quiet) setErr(String(e.message || e)); }
        finally { if (!quiet) setBusy(""); }
      }, []);

      const loadPersona = useCallback(async () => {
        try {
          const r = await fetch(API + "/persona");
          const j = await r.json();
          if (j.ok) { setPersonaText(j.text || ""); personaTextRef.current = j.text || "" }
        } catch { /* 人设读不到不影响主流程 */ }
      }, []);

      // 身份三件套：账号 / 人设 / 线路。切换走 /profiles，切完重读配置、人设正文与状态栏，
      // 否则页面上还是上一个号的名字、上一份人设的字。
      const [profiles, setProfiles] = useState(null);
      const [profBusy, setProfBusy] = useState("");
      const [profMsg, setProfMsg] = useState("");

      const loadProfiles = useCallback(async () => {
        try { const r = await fetch(API + "/profiles"); const j = await r.json(); if (j.ok) setProfiles(j); } catch { /* 身份读不到不影响主流程 */ }
      }, []);

      const prof = useCallback(async (body) => {
        setProfBusy(body.action); setProfMsg("");
        try {
          const r = await fetch(API + "/profiles", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          const j = await r.json();
          if (!j.ok) { setProfMsg(j.error || "切换失败"); return j; }
          if (j.accounts) setProfiles(j);
          await load();
          await loadPersona();
          await probe(true);
          return j;
        } catch (e) { setProfMsg(String(e.message || e)); return { ok: false }; }
        finally { setProfBusy(""); }
      }, [load, loadPersona, probe]);

      useEffect(() => { load(); loadPersona(); loadProfiles(); probe(true); }, [load, loadPersona, loadProfiles, probe]);

      /* ── 自动保存 ──
         没有保存按钮：改一次就排一次队，去抖 400ms 后把最新一份 cfg 提交上去。
         连点开关时上一个 POST 可能还在飞，所以用 ref 记「最新要存的那份」：
         请求回来发现又有新改动，就接着存；没有才算存干净。
         cfg 的当前值另存在 ref 里 —— 改配置是纯计算，不能塞进 setState 的 updater
         （React 会重复调用 updater，副作用会执行两遍）。 */
      const pending = useRef(null);   // 还没提交的最新配置
      const flying = useRef(false);   // 是否有一个 POST 在飞
      const timer = useRef(null);     // 去抖计时器

      const flush = useCallback(async () => {
        if (flying.current || !pending.current) return;
        const payload = pending.current;
        pending.current = null;
        flying.current = true;
        setSaveState("saving"); setErr("");
        // 中转站密钥单独一张表跟着这次提交走；空串（只是清掉输入框）不提交。
        const keys = Object.fromEntries(Object.entries(relayKeysRef.current || {})
          .map(([k, v]) => [String(k), String(v == null ? '' : v)])
          .filter(([, v]) => v.trim()))
        try {
          const r = await fetch(API + "/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // personaText 一起提交：服务端只在「本次动了人设」时才审它，
            // 否则 persona.md 里的旧内容会挡住之后每一次保存。
            body: JSON.stringify({
              config: payload,
              personaText: String(personaTextRef.current ?? ''),
              ...(Object.keys(keys).length ? { keys } : {}),
            }),
          });
          const j = await r.json();
          if (!j.ok) {
            setSaveState("failed");
            setErr(j.error || "保存失败");
            // 只说"哪一处不合规、去改哪里"，**不回显命中了哪个词**：
            // 把命中词打印在界面上等于给了一份「换哪个词能绕过去」的清单。
            // 服务端回的字段明细里也只有 label / 分组 / 类目，没有原文。
            const fields = Array.isArray(j.fields) ? j.fields : [];
            markBlocked({
              error: j.error || "保存失败",
              // 命中的字段路径（label 反查 FIELDS，用来把对应输入框描红）
              labels: fields.map((f) => f.label),
              groups: Array.isArray(j.groups) ? j.groups : [],
              // 被拒的分组 → 对应卡片高亮，用户知道该看哪张卡
              at: Date.now(),
            });
            return;
          }
          markBlocked(null);
          if (Object.keys(keys).length) { relayKeysRef.current = {}; setRelayKeys({}) }
          setWarn(j.warn || "");
          setSaveState("saved");
          // 服务端会把超范围的数值钳回去。只有这期间没人再改，才把规范化后的配置贴回界面，
          // 否则会把用户正在敲的东西冲掉。
          if (!pending.current && !timer.current && j.config) {
            cfgRef.current = j.config;
            setCfg(j.config);
          }
          probe(true);
        } catch (e) {
          setSaveState("failed");
          setErr(String(e.message || e));
        } finally {
          flying.current = false;
          if (pending.current) flush();
        }
      }, [probe]);

      /** 改一个字段：立刻更新界面，并把整份新配置排进保存队列 */
      const patch = useCallback((fn) => {
        const next = fn(cfgRef.current);
        cfgRef.current = next;
        setCfg(next);
        pending.current = next;
        // 一改就翻成「保存中…」：否则去抖那 400ms 里页尾还挂着上一轮的「✓ 已保存」，
        // 看起来像刚改的东西已经存好了，其实还在排队。
        setSaveState("saving");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; flush(); }, 400);
      }, [flush]);

      /* ── 中转站：列表增删启停走 patch，密钥走单独一张表 ── */
      const setRelayKey = useCallback((id, val) => {
        const next = { ...relayKeysRef.current, [String(id)]: String(val == null ? '' : val) };
        relayKeysRef.current = next;
        setRelayKeys(next);
      }, []);
      const relaysOf = (c) => (Array.isArray(c.ai?.relays) ? c.ai.relays : []);
      const addRelay = useCallback(() => patch((c) => {
        const cur = relaysOf(c);
        if (cur.length >= 12) return c;
        // id 用时间戳基数 36：设置页一次只会加一条，不追求全局唯一，只要和已有 id 不撞
        let id = 'relay-' + Date.now().toString(36);
        for (let n = 2; cur.some((r) => r.id === id); n++) id = 'relay-' + Date.now().toString(36) + '-' + n;
        return setPath(c, ["ai", "relays"], [...cur, { id, name: '中转站 ' + (cur.length + 1), baseUrl: '', model: '', enabled: true }]);
      }), [patch]);
      const dropRelay = useCallback((id) => patch((c) => {
        const next = setPath(c, ["ai", "relays"], relaysOf(c).filter((r) => r.id !== id));
        // 当前线路被删掉了就退回直连，否则保存后配置会指向一条不存在的线路
        if (next.ai?.activeRelay === id) return setPath(next, ["ai", "activeRelay"], 'direct');
        return next;
      }), [patch]);
      const toggleRelay = useCallback((id, on) => patch((c) => setPath(c, ["ai", "relays"],
        relaysOf(c).map((r) => (r.id === id ? { ...r, enabled: !!on } : r)))), [patch]);

      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const saveCookie = useCallback(async () => {
        setBusy("cookie"); setErr(""); setCkMsg("");
        try {
          const r = await fetch(API + "/cookie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ck),
          });
          const j = await r.json();
          setCkMsg(j.ok ? "✓ 已写入：" + j.nickname + "（" + j.uid + "）" : "✗ " + (j.error || "写入失败"));
          if (j.ok) { await load(); probe(true); }
        } catch (e) { setCkMsg("✗ " + String(e.message || e)); }
        finally { setBusy(""); }
      }, [ck, load, probe]);

      const runFollow = useCallback(async (send) => {
        setBusy("follow"); setTokMsg("");
        try {
          const r = await fetch(API + "/followback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", send: !!send }) });
          const j = await r.json();
          const x = (j && j.result) || {};
          setTokMsg(j.ok
            ? "✓ 本批 " + (x.due ?? 0) + " 个：成功 " + (x.ok ?? 0) + "，失败 " + (x.failed ?? 0) + (x.skipped ? "（" + x.skipped + "）" : "")
            : "✗ " + (j.error || "失败"));
          if (j.ok) probe(true);
        } catch (e) { setTokMsg("✗ " + String(e.message || e)) } finally { setBusy("") }
      }, [probe]);

      // 人设的保存合并进 saveIdentity（「她是谁」整组一个按钮），这里不再单独留一个。

      /**
       * 手动「保存」：把 cfgRef 里当前这份立刻提交（跳过 400ms 去抖）。
       * 自动保存仍在，但这颗按钮让"确实存下去了"有个明确的动作与反馈 ——
       * 之前的自动保存太安静，用户以为没有保存功能。
       */
      const saveNow = useCallback(async () => {
        const cur = cfgRef.current;
        if (!cur) return;
        pending.current = cur;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        await flush();
      }, [flush]);

      /**
       * 「她是谁」整组保存：配置里的文字（角色名 / 称呼 / 说话风格 / 提示词规则 / 末尾一句）
       * 走 /settings，人设补充走 /persona —— 两处分开存，但用户只按一次。
       * 先存配置：配置被安全闸拦下时人设就不要写了，避免"半份生效"。
       */
      const saveIdentity = useCallback(async () => {
        setBusy("identity"); setPersonaMsg("");
        try {
          const cur = cfgRef.current;
          if (cur) {
            pending.current = cur;
            if (timer.current) { clearTimeout(timer.current); timer.current = null; }
            await flush();
          }
          // 人设这次跟着配置一起提交了（见 flush），所以这里不用再打 /persona。
          // flush 被拒时 markBlocked 已经置上，直接返回让红条显示出来。
          if (blockedRef.current) return
          setPersonaMsg("✓ 已保存这一组")
        } catch (e) { setPersonaMsg("✗ " + String(e.message || e)); }
        finally { setBusy(""); }
      }, [flush, personaText]);

      const refreshStatus = useCallback(async () => {
        setNote(""); setOut("");
        await probe(false);
        try {
          const r = await fetch(API + "/status");
          const j = await r.json();
          if (!j.ok) return;
          const bb = j.browse;
          setOut([
            "账号：" + (j.credentials.present ? j.credentials.nickname + "（" + j.credentials.uid + "）" : "未登录"),
            "AI：" + (j.aiReady ? "已配置" : "未配置（地址 / 模型 / 密钥 缺一个）"),
            "读：" + j.traffic.readHour + "/时 " + j.traffic.readDay + "/天　写：" + j.traffic.writeHour + "/时 " + j.traffic.writeDay + "/天" + (j.traffic.pausedUntil ? "　⚠ 风控暂停中" : ""),
            "自动回帖：" + (j.listen.running ? "运行中" : "停") + (j.listen.lastTickAt ? "，上次扫描 " + new Date(j.listen.lastTickAt).toLocaleTimeString() : "") + (j.listen.lastError ? "\n　⚠ " + j.listen.lastError : ""),
            "自动刷帖：" + (!bb ? "时钟未启动" : (bb.enabled ? "开" : "关") + (bb.lastRunAt ? "，上次 " + new Date(bb.lastRunAt).toLocaleTimeString() : "，还没刷过") + (bb.hasSession ? "" : "\n　⚠ 宿主没给会话能力：只写日报，不会叫醒她")) + (bb && bb.lastError ? "\n　⚠ " + bb.lastError : ""),
            bb && bb.lastResult ? "　上轮：扫 " + bb.lastResult.scanned + " 帖 / 选 " + bb.lastResult.picked + " 帖 / 回 " + bb.lastResult.replied + " 条" : "",
          ].filter(Boolean).join("\n"));
        } catch (e) { setErr(String(e.message || e)); }
      }, [probe]);

      const toggleListen = useCallback(async (action) => {
        setBusy("listen");
        try {
          const r = await fetch(API + "/listen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          const j = await r.json();
          setNote(j.ok ? (action === "stop" ? "✓ 已停止" : "✓ 已启动") : "✗ " + (j.error || "操作失败"));
          probe(true);
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, [probe]);

      /** 试读一批游戏评价：只读，不写日报、不发任何评价。 */
      const tryGames = useCallback(async () => {
        setBusy("games"); setGamesPreview(null);
        try {
          const r = await fetch(API + "/browse", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "games" }),
          });
          const j = await r.json();
          if (!j.ok) { setGamesPreview({ ok: false, text: j.error || "读失败了" }); return; }
          const list = j.games || [];
          setGamesPreview({
            ok: true,
            text: list.length
              ? "读到 " + list.length + " 个游戏的评价：\n" + list.map((g) =>
                  "· " + (g.title || g.id) + "：平台 " + (g.star || "—") + " 分，共 " + (g.total || 0) + " 条，本轮读 " + g.read + " 条" +
                  (g.sample ? "\n  例如「" + g.sample + "」" : "")).join("\n")
              : "这一轮没拿到游戏评价（榜单没解析出来？）",
          });
        } catch (e) { setGamesPreview({ ok: false, text: String(e.message || e) }); }
        finally { setBusy(""); }
      }, []);

      const browse = useCallback(async (action, extra) => {
        setBusy("browse"); setErr(""); setOut(""); setNote("");
        try {
          const r = await fetch(API + "/browse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...(extra || {}) }),
          });
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "操作失败"); return; }
          if (action === "preview") {
            const cov = j.coverage || {};
            const pct = (v) => (Number.isFinite(Number(v)) ? Math.max(1, Math.round((1 - Number(v)) * 100)) + "%" : "—");
            const top = (j.top || []).map((x, i) =>
              String(i + 1).padStart(2, " ") + ". " + String(x.score).padStart(5) + " 分  " + x.title +
              "\n      " + (x.sectionTitle || "") + " · 回复 " + x.replyCount + " · 赞 " + x.upVote +
              " · 讨论度前 " + pct(x.dims && x.dims.discussion) + " · 热度前 " + pct(x.dims && x.dims.heat) +
              (x.excludedReason ? " · 已排除：" + x.excludedReason : "")
            ).join("\n");
            const covLine = cov.sections != null
              ? "覆盖 " + cov.sections + " 个板块 · 今日抓到 " + (cov.postsToday ?? j.scanned) + " 帖 · " +
                (cov.requests ?? "?") + " 次请求 · " + (cov.reachedCutoff === true ? "已翻到当日首帖" : "未翻到当日首帖（下轮继续补）")
              : "扫了 " + j.scanned + " 帖";
            setOut(covLine + "\n前 " + (j.top || []).length + " 名：\n" + top + "\n\n" + (j.log || []).join("\n"));
            return;
          }
          if (action === "run") {
            const s = j.stats || {};
            const P = s.post;
            const secName = P && P.section ? (P.section.title || "板块 " + P.section.id) : "";
            const postLine = !P ? ""
              : P.status === "posted" ? "\n✓ 已发帖到「" + secName + "」：" + P.title
              : P.status === "preview" ? "\n会发到「" + secName + "」：" + P.title
              : P.status === "failed" ? "\n✗ 发帖失败：" + (P.reason || "")
              : "\n没发帖：" + (P.reason || "");
            const bodyText = P && P.markdown ? P.markdown : (s.text || "");
            setOut("扫 " + s.scanned + " 帖，选 " + (s.picked || []).length + " 帖，回 " + (s.replied || 0) + " 条" +
              (s.dryRun ? "（预览，未真发）" : "") + "\n日报：" + (s.file || "（未写）") + postLine +
              "\n\n" + bodyText.slice(0, 3000) + ((j.log || []).length ? "\n\n" + j.log.join("\n") : ""));
            if (!s.dryRun) probe(true);
            return;
          }
          if (action === "sections") {
            setSecList(j.sections || []);
            setOut((j.sections || []).map((s) => s.id + "　" + s.title).join("\n") || "（没有板块）");
            return;
          }
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, [probe]);

      const loadDigest = useCallback(async () => {
        setBusy("digest"); setErr(""); setOut("");
        try {
          const r = await fetch(API + "/digest");
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "读取失败"); return; }
          const files = j.files || [];
          if (!files.length) { setOut("还没有日报。点「跑一轮」跑一次。"); return; }
          const r2 = await fetch(API + "/digest?date=" + files[0].date);
          const j2 = await r2.json();
          setOut("最近一份：" + files[0].date + "（" + files[0].bytes + " 字节）\n\n" + (j2.text || ""));
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, []);

      // 扫码成功后服务端已经把 self 写进配置文件了，这里不能只改本地 cfg ——
      // 本地那份会带着旧的 uid 一直显示，跟磁盘上真实登录态不一致。
      // 直接重读配置，让界面与服务端对齐。
      const updateAccount = useCallback(async (acc) => {
        await load();
        loadProfiles();
        probe(true);
        setNote("✓ 登录成功：" + (acc.nickname || "（没昵称）") + "（" + (acc.uid || "") + "）");
      }, [load, loadProfiles, probe]);

      const askSure = (text) => {
        try { return typeof window === "undefined" || typeof window.confirm !== "function" ? true : window.confirm(text); }
        catch { return true; }
      };

      const logout = useCallback(async () => {
        if (!askSure("退出后本机的快爆登录态会删掉，自动回帖和发帖都会停下，要再扫码才能恢复。确定退出？")) return;
        setBusy("logout"); setErr(""); setNote("");
        try {
          const r = await fetch(API + "/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "退出失败"); return; }
          setSwitching(false);
          await load();
          await probe(true);
          setNote("✓ 已退出登录");
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, [load, probe]);

      const loadCatalog = useCallback(async () => {
        setCatLoading(true);
        try {
          const r = await fetch(API + "/browse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "catalog" }) });
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "板块目录没拉到"); return; }
          setCatalog(j.sections || []);
        } catch (e) { setErr(String(e.message || e)); }
        finally { setCatLoading(false); }
      }, []);

      const postNow = useCallback(() => {
        const sec = cfgRef.current && cfgRef.current.post && cfgRef.current.post.section;
        if (!sec || !sec.id) { setErr("先在下面选好「发到哪个板块」"); return; }
        if (!askSure("会真的扫一轮、写日报，并以小号身份发一篇新帖到「" + (sec.title || sec.id) + "」。确定？")) return;
        browse("run", { dry: false, post: true });
      }, [browse]);

      /** 搜索跳转：先把目标卡里收着的「高级」展开（否则那行没有布局，滚不过去），再滚过去闪一下。 */
      const jumpTo = (field) => {
        const path = field.path.join(".");
        setQ(""); setFindMsg("");
        if (typeof document === "undefined" || !document.querySelector) return;
        const sel = '[data-hks-path="' + path + '"]';
        // 收在「高级」里的行在 DOM 里但没布局：先把它所在的那个 details 打开再滚。
        // 只开它自己那一个，别把整张卡的高级全摊开。
        const found = document.querySelector(sel);
        // 卡被箭头收起来时正文没布局：先点开那张卡的箭头，再找 details
        const cardEl = found && found.closest ? found.closest(".hks-card") : null;
        const chev = cardEl && cardEl.getAttribute("data-closed") === "1" ? cardEl.querySelector(".hks-chev") : null;
        if (chev && chev.click) chev.click();
        const box = found && found.closest ? found.closest("details") : null;
        if (box && !box.open) box.open = true;
        const el = document.querySelector(sel);
        if (!el) {
          setFindMsg("「" + (CARD_OF[field.sec] || CARD_FALLBACK) + "」这一项现在没渲染：先打开那张卡上的开关，再回来定位。");
          return;
        }
        if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
        if (el.classList) {
          el.classList.remove("hks-hit");
          void el.offsetWidth;   // 强制回流，连点两次也能重新播动画
          el.classList.add("hks-hit");
          setTimeout(() => el.classList.remove("hks-hit"), 1600);
        }
      };

      const hit = (x) => h("button", { key: x.key, type: "button", onClick: () => jumpTo(x.field) },
        x.label, h("span", null, "· " + x.card));

      const locked = !!busy || qrActive;

      if (!cfg) {
        return h("div", { className: "hks" },
          h("div", { className: "hks-head" }, h("div", { className: "hks-ht" }, h("h3", { className: "hks-title" }, "快爆小号"))),
          err ? h("div", { className: "hks-err" }, err) : h("div", { className: "hks-note" }, "读取配置中…"));
      }

      // 没写 tier 的字段就是 tier 1（默认显示）；只有显式 tier:2 才收进「高级」
      const bySec = (s, tier) => FIELDS.filter((f) => f.sec === s && (f.tier || 1) === tier);
      const acc = sys ? sys.credentials : null;
      const b = sys ? sys.browse : null;
      const aiReady = sys ? !!sys.aiReady : null;
      const replyOn = cfg.listen?.enabled === true;
      const browseOn = cfg.browse?.enabled === true;
      // 宿主调度器是不是真的在跑（/status 里的 listen.running）。启停按钮按它二选一显示。
      const listenRunning = !!(sys && sys.listen && sys.listen.running);
      // 测试模式优先：开着时服务端在内存里把所有功能放到最宽，下面卡片里的开关只是平时的配置，暂不生效
      const testOn = cfg.test?.enabled === true;
      const mode = testOn ? "test" : replyOn && browseOn ? "both" : replyOn ? "reply" : browseOn ? "browse" : "off";
      const setMode = (key) => patch((c) => {
        const t = setPath(c, ["test", "enabled"], key === "test");
        // 选测试模式时不动平时的开关，切回其他模式时原样恢复
        if (key === "test") return t;
        const n = setPath(t, ["listen", "enabled"], key === "reply" || key === "both");
        return setPath(n, ["browse", "enabled"], key === "browse" || key === "both");
      });
      /* 被保存闸拦下的字段：label 集合。Field 按 label 匹配后描红那一行。 */
      const badLabels = new Set((blocked && blocked.labels) || []);
      const fieldsOf = (s, tier) =>
        bySec(s, tier).map((f) => h(Field, {
          key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked,
          bad: badLabels.has(f.label),
        }));

      const pill = (label, state, text, tip) => h("span", { className: "hks-pill", key: label },
        h("span", { className: "hks-dot", "data-s": state }), label + " ", h("b", null, text),
        tip ? h(Tip, { text: tip, side: "bottom" }) : null);
      // 账号 pill 里带上当前人设名：一眼看出"谁在说话、用哪个号说"
      const curPersonaLabel = (() => {
        const ps = (profiles && profiles.personas) || [];
        const p = ps.find((x) => x.id === ((profiles && profiles.active) || {}).persona);
        return p ? p.label : "";
      })();

      return h("div", { className: "hks" },

        /* 页头：只留「刷新状态」按钮，标题与副标题按需求删掉 */
        h("div", { className: "hks-head" },
          h("div", { className: "hks-ht" }),
          h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: refreshStatus, disabled: locked },
            busy === "status" ? "读取中…" : "刷新状态")),

        /* 搜设置项：输入即筛，最多 3 条，点一条就跳过去并高亮；Esc 清空 */
        (() => {
          const hits = matchFields(FIELDS, q, 3);
          return h("div", { className: "hks-find" },
            h("span", { className: "hks-find-ic", "aria-hidden": "true" }),
            h("input", {
              className: "hks-in", type: "text", value: q,
              placeholder: "搜设置项：名称 / 说明 / 卡片名",
              "aria-label": "搜设置项",
              onChange: (e) => { setQ(e.target.value); setFindMsg(""); },
              onKeyDown: (e) => {
                if (e.key !== "Escape") return;
                setQ(""); setFindMsg("");
                if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur();
              },
            }),
            q.trim()
              ? h("div", { className: "hks-res" },
                  hits.length ? hits.map(hit) : h("p", null, "没有匹配「" + q.trim() + "」的设置项"))
              : null,
            findMsg ? h("div", { className: "hks-err", style: { paddingTop: "6px" } }, findMsg) : null);
        })(),

        /* 保存被安全闸拦下时，在页面顶部挂一条：只说"哪一处不合规、去改哪里"，
           不回显命中的具体词（回显等于给了一份"换哪个词能绕过去"的清单）。 */
        blocked
          ? h("div", { className: "hks-blocked", role: "alert" },
              h("div", { className: "hks-blocked-h" },
                h("b", null, "这次保存被拒绝了"),
                h("button", {
                  type: "button", className: "hks-link", onClick: () => { markBlocked(null); setErr("") },
                }, "知道了")),
              h("div", { className: "hks-blocked-b" }, blocked.error),
              h("div", { className: "hks-note" }, "改完会自动重试保存；也可以先点「知道了」把它收起来。"))
          : null,

        /* 身份条：账号 · 人设 · AI 线路，点一下换掉 */
        h(IdentityBar, { profiles, busy: profBusy, msg: profMsg, onAction: prof }),

        /* 状态条 */
        h("div", { className: "hks-chips" },
          pill("账号", !acc ? "" : acc.present ? "ok" : "bad",
            !acc ? "…" : acc.present ? ((acc.nickname || acc.uid) + (curPersonaLabel ? " · " + curPersonaLabel : "")) : "未登录",
            (acc && acc.why ? acc.why + "\n" : "") + "登录态按账号分别存在 ~/.hykb-ai/accounts/<uid>/，只有 uid 没有 Pauth 时能读不能写。"),
          pill("AI", aiReady === null ? "" : aiReady ? "ok" : "bad", aiReady === null ? "…" : aiReady ? "已接" : "未配置",
            "需要接口地址、模型名、密钥三项齐全。"),
          pill("回帖", testOn ? "warn" : !replyOn ? "warn" : "ok", testOn ? "测试" : replyOn ? "开" : "关", testOn ? "测试模式：回帖全开、不设过滤。" : "开着才会去扫 @。"),
          pill("刷帖", testOn ? "warn" : !browseOn ? "warn" : "ok", testOn ? "测试" : browseOn ? "开" : "关", testOn ? "测试模式：刷帖全开、自动回帖、发帖也开。" : "开着才会自己翻板块写日报。"),
          b && b.hasSession === false ? pill("叫醒", "bad", "宿主无会话能力", "宿主没给会话能力：日报照写，但不会在她的会话里说话。") : null),

        /* 用法：一次点掉所有开关 */
        h("div", { className: "hks-modes" }, MODES.map((m) => h("button", {
          key: m.key, type: "button", className: "hks-mode", "data-k": m.key, "data-on": mode === m.key ? 1 : 0,
          disabled: locked, onClick: () => setMode(m.key), title: m.key === "test" ? TEST_NOTE : undefined,
        },
          h("b", null, m.t),
          h("span", null, m.s)))),
        testOn
          ? h("div", { className: "hks-testbar" },
              h("b", null, "测试模式已开启　"), TEST_NOTE,
              " 自动回帖、自动刷帖、刷完回帖、发帖、叫醒全部打开，时间窗、人 / 板块 / 帖子过滤、一人一次冷却、选题分数门槛都不生效（只在运行时放宽，不改你下面填的配置；切回其他模式即恢复）。安全阀额度照旧，防止账号被风控。")
          : null,

        /* ① 登录 */
        h(Card, {
          no: 1, sec: "login",
          title: "登录账号",
          sub: acc && acc.present
            ? (switching ? "换号：扫新号的码，或贴新号的 Cookie。成功后直接替换当前账号。" : "她用这个号回帖、发帖。")
            : "扫码，或者手动粘贴浏览器里的 Cookie。两条路都行，成功后立刻写入，不用点保存。",
          badge: acc && acc.present ? { s: "ok", t: "已登录" } : { s: "warn", t: "必做" },
        },
          acc && acc.present && !switching
            ? h(AccountBox, { acc, disabled: locked, busy: busy === "logout", onSwitch: () => setSwitching(true), onLogout: logout })
            : h(QrLogin, {
                disabled: !!busy, onAccount: (a) => { setSwitching(false); updateAccount(a); }, onActiveChange: setQrActive,
                ck, setCk, onSave: saveCookie, saving: busy === "cookie", msg: ckMsg,
              }),
          acc && acc.present && switching
            ? h("div", { className: "hks-rowbtns", style: { justifyContent: "flex-start" } },
                h("button", { type: "button", className: "hks-link", disabled: !!busy, onClick: () => { setSwitching(false); setQrActive(false); } }, "不换了，用回 " + (acc.nickname || acc.uid)))
            : null,
          acc && acc.needLogin && acc.why ? h("div", { className: "hks-err" }, "⚠ " + acc.why) : null,
          h(AccountList, {
            profiles, busy: profBusy, onAction: prof,
            onRetire: (a) => {
              if (askSure("把「" + (a.label || a.id) + "」移出清单？凭据会挪进 accounts/.trash，之后能搬回来")) prof({ action: "retireAccount", id: a.id });
            },
          }),
          profMsg && !profiles ? h("div", { className: "hks-err" }, profMsg) : null),

        /* ② 接上 AI */
        h(Card, {
          no: 2, sec: "ai", title: "接上 AI",
          sub: "她写的话由这个模型生成。填 OpenAI 兼容的接口即可",
          badge: aiReady === false ? { s: "warn", t: "必做" } : aiReady ? { s: "ok", t: "已接" } : null,
        },
          /* 用户明确要求：这一行必须是看得见的字，不能只藏在 ⓘ 里 */
          h(WarnBar, { text: "严禁接入破甲模型！",
            sub: "模型名 / 接口地址 / 站名里带「无审查」「去限制」特征的一律拒收，保存时直接拦下。中转站里挂的同类权重同样算破甲模型。" }),
          fieldsOf("ai", 1),
          h("div", { className: "hks-h4" }, "中转站"),
          h("div", { className: "hks-note", style: { marginBottom: "6px" } },
            "先走「当前线路」，它挂了按顺序试下一条。密钥只进本机 relay-keys.json，页面永远只显示「已保存」。"),
          profiles
            ? h(Row, { label: "当前线路", hint: "点一下立刻换（不用保存）。没有密钥的线路是灰的。\n回退开关在下面：关掉就只试这一条" },
                h("div", { className: "hks-inl" }, ((profiles && profiles.lines) || []).map((l) => h("button", {
                  key: l.id, type: "button", className: "hks-tag",
                  "data-on": (profiles.active || {}).line === l.id ? 1 : 0,
                  disabled: locked || !!profBusy || !l.hasKey,
                  onClick: () => prof({ action: "switchLine", id: l.id }),
                }, l.name + (l.hasKey ? "" : "（无密钥）")))))
            : null,
          fieldsOf("ai", 3),
          h(RelayList, {
            relays: cfg.ai?.relays || [], disabled: locked,
            keys: relayKeys, setKey: setRelayKey,
            onAdd: addRelay, onDrop: dropRelay, onToggle: toggleRelay,
            onChange: (id, field, value) => patch((c) => setPath(c, ["ai", "relays"],
              (c.ai?.relays || []).map((r) => (r.id === id ? { ...r, [field]: value } : r)))),
          }),
          h(More, null, fieldsOf("ai", 2))),

        /* ③ 她是谁 */
        h(Card, { no: 3, sec: "who", title: "她是谁", sub: "决定她的口吻。这三行直接影响回帖质量" },
          /* 这一组的文字（角色名 / 称呼 / 说话风格 / 人设补充 / 提示词规则 / 末尾一句）
             合起来就是她的"人设与口吻"，所以合成一个保存动作：
             一个按钮存掉「她是谁 + 提示词」，被拦时整组一起描红。自动保存仍在，这是给确认用的。 */
          h(PersonaBar, { profiles, busy: profBusy, onAction: prof }),
          fieldsOf("who", 1),
          h(Row, { label: "人设补充", hint: "自由文本，会拼进系统提示。写她不会做什么比写她会做什么更有效。\n每个人设各存一份：切到别的人设就是另一段字", block: true, "data-bad": badLabels.has("人设补充") ? "1" : null },
            h("textarea", {
              className: "hks-ta",
              value: personaText,
              placeholder: "例如：喜欢用短句和克制的吐槽；不主动提游戏外的话题；不刷表情",
              onChange: (e) => { setPersonaText(e.target.value); personaTextRef.current = e.target.value },
            })),
          h("div", { className: "hks-h4" }, "提示词"),
          h(WarnBar, { text: "严禁添加破甲提示词！",
            sub: "这里的内容会直接拼进系统提示，一句「越狱」话就能把上面所有硬规则全部作废，所以检测到这类话术会拒绝保存。" }),
          fieldsOf("prompt", 1),
          /* 空着不等于不加：服务端会回落到「-内容由AI生成」。这里把实际生效的那句显示出来，
             免得用户以为留空就没后缀了。 */
          h("div", { className: "hks-note" },
            "实际生效：「……正文 " + (String(cfg.prompt?.suffix || "").trim() || "-内容由AI生成") + "」"),
          /* 整组一个保存动作：先存配置（角色名/称呼/风格/提示词规则/末尾一句），再存人设。
             任一被安全闸拦下就停下来，不写半份。 */
          h("div", { className: "hks-rowbtns", style: { paddingTop: "8px" } },
            personaMsg ? h("span", { className: personaMsg.startsWith("✓") ? "hks-ok" : "hks-err" }, personaMsg) : null,
            h("button", {
              type: "button", className: "hks-btn", "data-v": "primary", "data-sz": "sm",
              disabled: locked, onClick: saveIdentity,
            }, busy === "identity" ? "保存中…" : "保存这一组")),
          h("div", { className: "hks-h4" }, "表情"),
          fieldsOf("emoji", 1),
          h(More, null, fieldsOf("who", 2))),

        /* ④ 自动回帖 */
        h(Card, {
          no: 4, sec: "reply", title: "自动回帖",
          sub: replyOn
            ? "开着：每 " + (cfg.listen?.intervalSec ?? "-") + " 秒扫一次，有人 @ 她就回。"
            : "关着：不会主动发任何回复。",
          badge: replyOn ? { s: "ok", t: "开" } : null,
          off: !replyOn,
          right: h(Sw, { on: replyOn, disabled: locked, onChange: (v) => patch((c) => setPath(c, ["listen", "enabled"], v)) }),
        },
          replyOn
            ? [
                h(Row, { key: "iv", label: "扫描间隔（秒）", hint: "20–3600，默认 60。太短会白烧读额度" },
                  h("input", {
                    className: "hks-in", type: "number", disabled: locked, value: cfg.listen?.intervalSec ?? "",
                    onChange: (e) => patch((c) => setPath(c, ["listen", "intervalSec"], e.target.value === "" ? "" : Number(e.target.value))),
                  })),
                h(SwRow, {
                  key: "allday", label: "全天扫", hint: "关掉后只在「时间段」里扫",
                  on: cfg.listen?.allDay !== false, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["listen", "allDay"], v)),
                }),
                /* @ 怎么才算叫我：平台只有互相关注才发得出真 @，所以两条路都得能选 */
                (() => {
                  const cur = cfg.listen?.triggerMode || "both";
                  return h(Row, {
                    key: "trig",
                    label: "怎么算 @ 我",
                    hint: "真 @ 是富文本标签，平台会校验好友关系——只有互相关注的人才发得出去。\n纯文本「@昵称」任何号都能打，不要求好友，但可能有人手打昵称冒充叫你。\n拿不准就留「两种都认」",
                    block: true,
                  }, h("div", { className: "hks-seg" }, TRIGGER_OPTS.map((o) => h("button", {
                    key: o.key, type: "button", "data-on": cur === o.key ? 1 : 0, disabled: locked,
                    onClick: () => patch((c) => setPath(c, ["listen", "triggerMode"], o.key)),
                  }, o.t))));
                })(),
                h("div", { key: "seg", className: "hks-seg" }, SOURCES.map((d) => h("button", {
                  key: d.key, type: "button", "data-on": tab === d.key ? 1 : 0, disabled: locked,
                  onClick: () => setTab(d.key),
                },
                  d.tab,
                  getPath(cfg, ["listen", d.key, "enabled"]) ? h("span", { className: "hks-dot", "data-s": "ok" }) : null))),
                /* 创作 / 官方内容不回复：三类各一个开关，官方还能按人放行或强制跳过 */
                h("div", { key: "skiph", className: "hks-h4" }, "创作 / 官方内容不回复"),
                h(SwRow, {
                  key: "ske", label: "精华帖不接话",
                  hint: "帖子带「精华」标记时哪怕 @ 了她也不回。\n这类内容是人家认真写的，接一句反而像刷回复。",
                  on: cfg.listen?.skip?.essence !== false, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["listen", "skip", "essence"], v)),
                }),
                h(SwRow, {
                  key: "sko", label: "官方发布不接话",
                  hint: "帖子是官方号发的就跳过。\n下面两个名单可以点名放行 / 强制跳过（黑名单优先）。",
                  on: cfg.listen?.skip?.official !== false, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["listen", "skip", "official"], v)),
                }),
                h(Row, {
                  key: "skoallow", label: "官方白名单", block: true,
                  hint: "填 uid 或昵称：这些号的官方内容照常回（开关开着也回）。留空 = 不点名放行",
                }, h(ListInput, {
                  value: cfg.listen?.skip?.officialAllow || [], disabled: locked,
                  placeholder: "例如 162319955 或 快爆官方",
                  onChange: (arr) => patch((c) => setPath(c, ["listen", "skip", "officialAllow"], arr)),
                })),
                h(Row, {
                  key: "skodeny", label: "官方黑名单", block: true,
                  hint: "填 uid 或昵称：这些号的官方内容一律不回，优先于白名单",
                }, h(ListInput, {
                  value: cfg.listen?.skip?.officialDeny || [], disabled: locked,
                  placeholder: "例如 广告号 uid",
                  onChange: (arr) => patch((c) => setPath(c, ["listen", "skip", "officialDeny"], arr)),
                })),
                h(SwRow, {
                  key: "skc", label: "长文投稿不接话",
                  hint: "帖子带「文章投稿」标记时跳过。\n和精华一样，那是人家正式写的东西。",
                  on: cfg.listen?.skip?.contribution !== false, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["listen", "skip", "contribution"], v)),
                }),
                (() => {
                  const def = SOURCES.find((d) => d.key === tab) || SOURCES[0];
                  const on = !!getPath(cfg, ["listen", def.key, "enabled"]);
                  return h("div", { key: "src" },
                    h(SwRow, {
                      label: def.noItems ? "读消息中心的「@我的」" : "扫「" + def.tab + "」", hint: def.hint,
                      on, disabled: locked,
                      onChange: (v) => patch((c) => setPath(c, ["listen", def.key, "enabled"], v)),
                    }),
                    h(SourcePanel, { def, cfg, setCfg: patch, disabled: locked, onPickSections: () => browse("sections") }));
                })(),
                fieldsOf("reply", 1),
                h(More, { key: "adv" }, fieldsOf("reply", 2)),
                h("div", { key: "btns", className: "hks-rowbtns", style: { paddingTop: "8px" } },
                  h("button", {
                    type: "button",
                    className: "hks-btn",
                    "data-v": listenRunning ? "ghost" : "outline",
                    "data-sz": "sm",
                    disabled: locked,
                    onClick: () => toggleListen(listenRunning ? "stop" : "start"),
                  }, busy === "listen" ? "处理中…" : listenRunning ? "停止" : "启动")),
              ]
            : null),

        /* ⑤ 自动刷论坛 */
        h(Card, {
          no: 5, sec: "browse", title: "刷论坛 · 日报发帖",
          sub: browseOn
            ? "开着：每 " + Math.round((cfg.browse?.intervalSec ?? 3600) / 60) + " 分钟扫一轮，" + (cfg.browse?.pick ?? 8) + " 帖进日报" +
              (cfg.post?.enabled && cfg.post?.section?.id ? "，发到「" + (cfg.post.section.title || cfg.post.section.id) + "」" : "") +
              (cfg.browse?.wake !== false ? "，然后叫醒她的会话。" : "。")
            : "关着：不会自己扫板块、不写日报、不发帖。打开后可以选读哪些板块、发到哪个板块。",
          badge: browseOn ? { s: "ok", t: "开" } : null,
          off: !browseOn,
          right: h(Sw, { on: browseOn, disabled: locked, onChange: (v) => patch((c) => setPath(c, ["browse", "enabled"], v)) }),
        },
          browseOn
            ? [
                h(Row, { key: "secs", label: "读哪些板块", hint: "日报的候选池是「今天全站发过的帖」，默认覆盖板块目录里全部公共板块（约 49 个，上限 " + (cfg.browse?.maxSections ?? 60) + " 个）。\n想把范围收窄到指定板块：配置文件里把 browse.coverage.mode 设成 picked，再在这里选板块。", block: true },
                  h(SectionPicker, {
                    multi: true, value: cfg.browse?.sections || [], disabled: locked,
                    catalog, onLoad: loadCatalog, loading: catLoading, empty: "没选，读默认的六个公共讨论区",
                    onChange: (v) => patch((c) => setPath(c, ["browse", "sections"], v)),
                  })),
                bySec("browse", 1).filter((f) => f.kind !== "switch").map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
                bySec("browse", 1).filter((f) => f.kind === "switch" && f.path[1] !== "enabled").map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
                h(More, { key: "adv" }, fieldsOf("browse", 2)),
                b && b.hasSession === false
                  ? h("div", { key: "nosession", className: "hks-err" }, "⚠ 宿主没给会话能力：日报照写，但不会叫醒她（headless 模式下属正常）")
                  : null,
                h("div", { key: "posth", className: "hks-h4" }, "把日报发成帖子"),
                h(SwRow, {
                  key: "posten", label: "每轮写完自动发帖",
                  hint: "会真的发出去：以小号身份在选定板块发一篇文章帖，内容就是这期日报，文末附原帖链接。\n受「一天最多发几篇」和「安全阀」写额度约束",
                  on: cfg.post?.enabled === true, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["post", "enabled"], v)),
                }),
                h(Row, { key: "postsec", label: "发到哪个板块", hint: "只能选一个。发之前先确认这个板块允许发文章帖", block: true },
                  h(SectionPicker, {
                    multi: false, value: cfg.post?.section || null, disabled: locked,
                    catalog, onLoad: loadCatalog, loading: catLoading, empty: "还没选，选了才能发",
                    onChange: (v) => patch((c) => setPath(c, ["post", "section"], v)),
                  })),
                bySec("post", 1).map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
                h(More, { key: "postadv" }, fieldsOf("post", 2)),
                sys && sys.post && sys.post.last
                  ? h("div", { key: "postlast", className: sys.post.last.ok ? "hks-note" : "hks-err" },
                      "上一篇：" + (sys.post.last.ok ? "✓ " : "✗ ") + (sys.post.last.title || "") + (sys.post.last.ok ? "" : "（" + (sys.post.last.msg || "失败") + "）") + "　今天已发 " + (sys.post.today || 0) + " 篇")
                  : null,
                /* 游戏评价观察：只读。挑游戏 → 读玩家评价 → 进日报，不发任何评价 */
                h("div", { key: "gamesh", className: "hks-h4" }, "游戏评价观察（只读）"),
                h(SwRow, {
                  key: "gen", label: "日报里加一段游戏评价",
                  hint: "每轮挑几个游戏，读玩家在它们下面的评价，让 AI 压成一段写进日报。\n**只读**：这条链路上没有「发评价」的接口，也不会替她打分 —— 平台对刷好评有礼仪考试闸。\n关掉 = 日报里没有这一段。",
                  on: cfg.games?.enabled === true, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["games", "enabled"], v)),
                }),
                cfg.games?.enabled === true
                  ? [
                      h(Row, { key: "gsrc", label: "从哪个榜单挑", block: true, hint: "读的是手机版榜单页（服务端直接给 id 和名字）。\n二次元 / 玩家 / 开发者榜是 JS 渲染的，读不到" },
                        h("div", { className: "hks-seg" }, GAME_SOURCES.map((o) => h("button", {
                          key: o.key, type: "button", "data-on": (cfg.games?.source || "hot") === o.key ? 1 : 0, disabled: locked,
                          onClick: () => patch((c) => setPath(c, ["games", "source"], o.key)),
                        }, o.t)))),
                      h(Row, {
                        key: "glist", label: "指定游戏 id", block: true,
                        hint: "填了就只读这些（纯 id，逗号分隔），每轮取前「每轮看几个游戏」个。\n留空 = 从上面那个榜单里按顺序取。\n嫌榜单上的游戏没兴趣，就填自己关心的。",
                      }, h(ListInput, {
                        value: (cfg.games?.items || []).map((x) => (x && typeof x === "object" ? x.id : x)).filter(Boolean),
                        disabled: locked, placeholder: "例如 151743，89222",
                        onChange: (arr) => patch((c) => setPath(c, ["games", "items"], arr.map((id) => ({ id: String(id), title: "" })))),
                      })),
                      bySec("games", 1).map((f2) => h(Field, { key: f2.path.join("."), field: f2, cfg, setCfg: patch, disabled: locked })),
                      h(More, { key: "gadv" }, fieldsOf("games", 2)),
                      gamesPreview
                        ? h("div", { key: "gprev", className: gamesPreview.ok ? "hks-note" : "hks-err" }, gamesPreview.text)
                        : null,
                    ]
                  : null,
                h("div", { key: "btns", className: "hks-rowbtns", style: { paddingTop: "8px", justifyContent: "flex-start" } },
                  h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: () => browse("preview"), disabled: locked }, busy === "browse" ? "扫帖中…" : "预览选题"),
                  h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: tryGames, disabled: locked }, busy === "games" ? "读评价中…" : "试读一批评价"),
                  h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: () => browse("run", { dry: true, post: true }), disabled: locked }, "跑一轮（不真发）"),
                  h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: postNow, disabled: locked || !(acc && acc.present) }, "现在发一篇"),
                  h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", onClick: loadDigest, disabled: locked }, busy === "digest" ? "读取中…" : "看最新日报")),
              ]
            : null),

        /* ⑥ 自动点赞：三类各一个开关，没有总开关 —— 关掉全部三个就等于关了 */
        (() => {
          const lk = cfg.like || {};
          const on = ["browsed", "quality", "replies"].filter((k) => lk[k] === true).length;
          return h(Card, {
            no: 6, sec: "like", title: "自动点赞",
            sub: on
              ? "开着 " + on + " 项：读帖时顺手点个赞，每轮最多 " + (lk.perRoundMax ?? 5) + " 个，到数就停。"
              : "关着：不会给任何内容点赞。下面三类可以分开打开。",
            badge: on ? { s: "ok", t: "开 " + on } : null,
          },
            fieldsOf("like", 1),
            h(More, null, fieldsOf("like", 2)));
        })(),

        /* ⑦ 自动回关 */
        (() => {
          const fb = cfg.followback || {};
          const on = fb.enabled === true;
          const st = (sys && sys.follow) || {};
          const cap = fb.dailyCap == null ? 20 : fb.dailyCap;
          return h(Card, {
            no: 7, sec: "focus", title: "自动回关",
            sub: on
              ? "开着：每轮读一次粉丝列表，把还没回关的人回关，一天最多 " + cap + " 个。"
              : "关着：只记录谁关注了你，不会替你关注任何人。",
            badge: on ? { s: "ok", t: "开" } : null,
            off: !on,
            right: h(Sw, { on, disabled: locked, onChange: (v) => patch((c2) => setPath(c2, ["followback", "enabled"], v)) }),
          },
            [
              h("div", { key: "st", className: st.error ? "hks-err" : "hks-note" },
                "待回关 " + (st.pending || 0) + " 个　今天已回关 " + (st.today || 0) + "/" + cap +
                (st.error ? "（" + st.error + "）" : "")),
              bySec("focus", 1).map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
              fieldsOf("focus", 2),
              tokMsg ? h("div", { key: "tokmsg", className: tokMsg.indexOf("✓") === 0 ? "hks-ok" : "hks-err" }, tokMsg) : null,
              h("div", { key: "btns", className: "hks-rowbtns", style: { paddingTop: "8px", justifyContent: "flex-start" } },
                h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled: locked, onClick: () => runFollow(false) }, busy === "follow" ? "处理中…" : "试跑一轮（不真关注）"),
                h("button", { type: "button", className: "hks-btn", "data-v": "outline", "data-sz": "sm", disabled: locked, onClick: () => runFollow(true) }, "立刻回关一轮")),
            ])
        })(),

        /* ⑧ 安全阀：额度账本 + 读节奏 + 内容安全（同属"别把事情搞砸"的一组，合成一张卡） */
        h(Card, { no: 8, sec: "risk", title: "安全阀", sub: "出网请求共用这一份额度账本；下面还有内容安全三道闸" },
          fieldsOf("risk", 1),
          h("div", { className: "hks-h4" }, "读节奏与复读"),
          fieldsOf("risk", 3),
          h(More, null, fieldsOf("risk", 2)),
          h("div", { className: "hks-h4" }, "内容安全"),
          h(SafetyPanel, { cfg, setCfg: patch, sys, locked, busy, setBusy })),

        out || secList
          ? h(Card, {
              id: "out",
              title: "运行记录",
              right: h("button", { type: "button", className: "hks-link", onClick: () => { setOut(""); setSecList(null); } }, "清空"),
            },
              h("pre", { className: "hks-log" }, out))
          : null,

        /* 运行日志 + 一键自检（不编号，不算设置步骤） */
        /* 浏览记录：帖粒度（读过 / 回过 / 跳过 + 三个时间），不编号，和运行日志并列 */
        h(HistoryPanel, { sys, locked }),

        h(ActivityPanel, { testOn, sys, risk: cfg.risk, locked, onDone: () => probe(true) }),

        err ? h("div", { className: "hks-err" }, err) : null,

        /* 保存状态：没有按钮，改完自己存；这行是唯一能看到的确认。 */
        h("div", { className: "hks-saverow" },
          h("span", { className: SAVE_TEXT[saveState].cls, "data-save": saveState }, SAVE_TEXT[saveState].text),
          warn ? h("span", { className: "hks-err" }, "⚠ " + warn) : null,
          note ? h("span", { className: note.startsWith("✓") ? "hks-ok" : "hks-err" }, note) : null));
    }

    const inject = ["slots"];
    const NS = "hykb-scroll";
    const NAMES = { nav: "刷快爆" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 8, label: () => NAMES.nav },
              HykbScrollSection,
            ),
            "hykb-scroll: settings section",
          ),
        "hykb-scroll: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.HykbScrollSection = HykbScrollSection;
    exports.FIELDS = FIELDS;
    exports.CARD_OF = CARD_OF;
    exports.matchFields = matchFields;
    return module.exports;
  },
});
