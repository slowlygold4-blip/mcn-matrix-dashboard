# 未接入生产的页面几何实验

原 `lib/phase71-profile-root-geometry.mjs` 只有独立测试引用，服务、provider 和日常采集均未接入。保留实验源码与测试，移出生产 lib/ 与默认回归目录，避免误认为采集链路已使用该能力。

它只产生页面几何观测，不能验证作者、作品完整性或授予任何采集动作。

手工运行：`node --test experiments/profile-root-geometry/profile-root-geometry.test.mjs`。
