// This classic script also runs from file://. HTTP keeps its existing assets,
// routes, session checks and module initialization entirely unchanged.
(() => {
  if (location.protocol !== 'file:') return;

  document.documentElement.dataset.localEntry = 'true';
  const style = document.createElement('style');
  style.textContent = `
    html[data-local-entry="true"] { background: #f5f7fb; color: #1d2c43; }
    html[data-local-entry="true"] body { margin: 0; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    html[data-local-entry="true"] body > :not(#localFileEntry) { display: none !important; }
    #localFileEntry { box-sizing: border-box; width: min(640px, calc(100% - 40px)); margin: 12vh auto; padding: 36px; background: white; border: 1px solid #e0e6ef; border-radius: 18px; box-shadow: 0 12px 36px #223a5b0a; }
    #localFileEntry h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.3; }
    #localFileEntry p { margin: 12px 0; }
    #localFileEntry .entry-caption { color: #536680; font-size: 14px; }
    #localFileEntry a { display: inline-block; margin: 12px 0; padding: 12px 20px; background: #255ed3; color: white; border-radius: 9px; text-decoration: none; font-weight: 600; }
    #localFileEntry a:focus-visible { outline: 3px solid #8caef3; outline-offset: 4px; }
    #localFileEntry .entry-recovery { padding-top: 16px; border-top: 1px solid #e0e6ef; }
    @media (max-width: 480px) { #localFileEntry { margin: 24px auto; padding: 24px; } #localFileEntry h1 { font-size: 24px; } }
  `;
  document.head.appendChild(style);

  const renderEntry = () => {
    const target = new URL('http://127.0.0.1:4188/');
    target.search = location.search;
    target.hash = location.hash;
    const main = document.createElement('main');
    main.id = 'localFileEntry';
    main.setAttribute('aria-labelledby', 'localFileEntryTitle');
    const heading = document.createElement('h1');
    heading.id = 'localFileEntryTitle';
    heading.textContent = '请从本机服务打开矩阵数据台';
    const explanation = document.createElement('p');
    explanation.textContent = '当前打开的是本地文件，不是正在运行的工作台。这里不会连接账号、读取快照或触发采集。';
    const link = document.createElement('a');
    link.href = target.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '打开工作台（新标签）';
    const caption = document.createElement('p');
    caption.className = 'entry-caption';
    caption.textContent = '本机地址：http://127.0.0.1:4188/ · 已保留原链接的筛选、日期与页面位置。需要这台电脑的工作台服务正在运行。';
    const recovery = document.createElement('p');
    recovery.className = 'entry-recovery';
    recovery.textContent = '如果新标签无法打开：请先确认本机服务是否已启动。仅在服务未启动时，回到项目文件夹双击“启动抖音监控台.command”；如已有服务仍无法访问，请联系管理员检查。不要反复启动，也不需要重新授权平台账号。';
    const note = document.createElement('p');
    note.className = 'entry-caption';
    note.textContent = '此入口不检测服务在线状态，也不会自动启动、重启或修改设置。新标签打不开时，可回到这里查看说明。';
    main.append(heading, explanation, link, caption, recovery, note);
    document.body.prepend(main);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderEntry, { once: true });
  else renderEntry();
})();
