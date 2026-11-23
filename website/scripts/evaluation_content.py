"""Enterprise evaluation entry and a concrete trial/acceptance guide."""


def publish_evaluation_pages(write_page, doc):
    body = '''
<section class="evaluation-hero wrap">
  <div class="breadcrumb"><a href="/">OpenWorkBuddy</a> / 企业评估</div>
  <div class="kicker">ONE TASK. A REAL TRIAL.</div>
  <h1>拿你的一项任务，<br>一起跑一次。</h1>
  <p class="lead">看过演示，下一步可以换成你的场景。先说清任务、使用对象、规模和时间，再一起确定试跑范围与验收方式。</p>
</section>
<section class="evaluation-layout wrap" aria-label="企业评估申请">
  <aside class="evaluation-intro">
    <span class="evaluation-step">01 / 从一项任务开始</span>
    <h2>先跑通，再决定<br>怎么用起来。</h2>
    <p>可以是团队的一份周报，也可以是准备交给客户的一个业务流程。优先选择手头有样例资料、做完能判断好坏的任务。</p>
    <ol class="evaluation-process">
      <li><b>说清一项任务</b><span>给出输入资料的类型、想要的成果和使用对象。</span></li>
      <li><b>约定一次试跑</b><span>沟通样例资料、模型与工具条件，确认范围和验收要求。</span></li>
      <li><b>拿成果做判断</b><span>一起核对文件、事实和修改结果，再商定授权与实施。</span></li>
    </ol>
    <a class="text-link" href="/guides/project-trial/">项目试用与验收说明 ↗</a>
    <div class="evaluation-selfserve"><b>想先自己试一下？</b><p>已有的 4 页项目汇报 PPT 样例可以直接开始。</p><a class="text-link" href="/guides/quick-start/#first-task">打开样例任务 ↗</a></div>
  </aside>
  <div class="evaluation-card">
    <form id="enterprise-evaluation" aria-describedby="evaluation-help">
      <fieldset class="evaluation-purpose">
        <legend>你准备怎样使用？</legend>
        <div class="evaluation-options">
          <label><input type="radio" name="purpose" value="internal" checked required><span><b>团队内部使用</b><small>岗位提效、团队办公与私有化</small></span></label>
          <label><input type="radio" name="purpose" value="delivery" required><span><b>给客户交付 / 产品集成</b><small>客户项目、行业方案与业务集成</small></span></label>
        </div>
      </fieldset>
      <div class="evaluation-field"><label for="evaluation-task"><span>01</span> 要跑什么任务？</label><textarea id="evaluation-task" name="task" rows="4" maxlength="1200" required placeholder="例如：把项目纪要和进度表整理成周报 PPT，并生成带负责人和截止时间的待办 Excel。"></textarea><small>说清已有资料和希望拿到的成果，样例资料可在沟通时再提供。</small></div>
      <div class="evaluation-field"><label for="evaluation-audience"><span>02</span> 给谁用？</label><input id="evaluation-audience" name="audience" maxlength="240" required placeholder="例如：项目经理和业务负责人"></div>
      <div class="evaluation-field"><label for="evaluation-scale"><span>03</span> 大约多少人或客户？</label><input id="evaluation-scale" name="scale" maxlength="160" required placeholder="例如：先给 5 人试跑，后续团队约 30 人"></div>
      <div class="evaluation-field"><label for="evaluation-timeline"><span>04</span> 什么时候要用？</label><input id="evaluation-timeline" name="timeline" maxlength="160" required placeholder="例如：本周先看试跑结果，下个月开始团队试点"></div>
      <button class="btn evaluation-submit" type="submit">生成我的试跑需求 <span aria-hidden="true">↗</span></button>
      <p class="evaluation-help" id="evaluation-help">先生成需求说明，再通过邮箱或微信发给我们。生成时不会自动发送。</p>
    </form>
    <section class="evaluation-result" id="evaluation-result" aria-labelledby="evaluation-result-title" hidden>
      <div class="kicker">READY TO START A CONVERSATION</div>
      <h2 id="evaluation-result-title" tabindex="-1">带着这项任务，开始沟通。</h2>
      <pre id="evaluation-brief"></pre>
      <div class="actions"><a class="btn" id="evaluation-email" href="mailto:contact@aijentra.com">打开邮件，发送需求 ↗</a><button class="btn secondary" id="evaluation-copy" type="button">复制需求到微信</button></div>
      <p>收件人：<a href="mailto:contact@aijentra.com">contact@aijentra.com</a><br>微信：<strong>agi_smith</strong> <button class="copy-btn evaluation-wechat" type="button" data-copy="agi_smith">复制微信号</button></p>
      <p class="evaluation-help">邮件客户端打开后，请检查正文并点击发送。微信沟通时，把上面的需求一起发来，便于围绕你的样例任务安排试跑。</p>
    </section>
    <noscript><p>可直接发邮件至 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a> 或添加微信 agi_smith，说明任务、使用对象、人数或客户数，以及期望时间。</p></noscript>
  </div>
</section>
<section class="evaluation-license wrap"><p>企业实际业务、客户交付与产品集成按<a href="/commercial-license/">商业授权</a>约定实施。试跑范围、费用与后续支持在开始前沟通确认。</p></section>
<script src="/assets/evaluation.js?v=20261116-evaluation" defer></script>
'''
    write_page(
        '/enterprise-evaluation/',
        '申请企业评估｜用你的任务试跑 OpenWorkBuddy',
        '选择团队内部使用或客户交付与产品集成，只需说明任务、使用对象、人数或客户规模和期望时间，生成可通过邮箱或微信发送的 OpenWorkBuddy 试跑需求。',
        body,
    )
    doc(
        '/guides/project-trial/',
        '项目试用与验收说明｜OpenWorkBuddy 企业评估',
        '从一项样例任务开始评估 OpenWorkBuddy，约定输入资料、成果文件、事实核对、可编辑性与修改结果，再决定企业内部使用或客户交付的实施范围。',
        '从一项任务开始，<br>用成果决定下一步。',
        '第一次试跑先选一个边界清楚的任务。看完演示后，用你自己的样例资料、目标成果和验收要求验证是否适合。',
        [
            ('start', '两条路径，从你的用途开始', '<p><strong>团队内部使用：</strong>选一个岗位的高频任务，例如项目周报、会议摘要或经营报表，明确谁提供资料、谁检查成果。</p><p><strong>给客户交付 / 产品集成：</strong>选一个具体客户或产品场景，明确使用对象、需要连接的系统、交付成果和你的实施边界。</p><p><a class="btn" href="/enterprise-evaluation/?from=trial-guide">申请企业评估 ↗</a></p>'),
            ('sample', '自助体验：继续用已有 PPT 样例', '<p>先按<a href="/guides/quick-start/#first-task">快速开始里的 4 页项目汇报 PPT</a>跑通安装、模型连接、生成与文件打开。这个样例适合熟悉工作台；评估企业场景时，再换成你自己的任务和资料。</p>'),
            ('scope', '沟通试跑：首轮只需四件事', '<ol><li><strong>要跑什么任务：</strong>现有资料是什么，希望拿到什么成果。</li><li><strong>给谁用：</strong>具体岗位、部门、客户或产品用户。</li><li><strong>大约多少人或客户：</strong>首批试跑规模与后续计划。</li><li><strong>什么时候要用：</strong>期望看试跑结果和开始使用的时间。</li></ol><p>通过<a href="/enterprise-evaluation/">评估入口</a>生成说明，发到 contact@aijentra.com 或微信 agi_smith。后续围绕这一项任务确认样例资料、模型和工具条件、试跑范围与费用。</p>'),
            ('acceptance', '开始前，一起写清验收要求', '<table><caption>第一次试跑的验收记录</caption><thead><tr><th>验收项</th><th>检查方法</th></tr></thead><tbody><tr><td>成果文件</td><td>按约定交付 PPT、Word、Excel 或网页，文件可以打开。</td></tr><tr><td>事实与数字</td><td>对照输入资料核对，不明信息明确标记待确认。</td></tr><tr><td>可编辑性</td><td>在对应办公软件中修改文字、表格或结构。</td></tr><tr><td>继续修改</td><td>追加一次指定修改，检查修改结果和应保留的内容。</td></tr><tr><td>运行条件</td><td>记录使用的模型、工具、权限及实际可观察的耗时和费用。</td></tr></tbody></table><p>验收由约定的使用者或负责人检查。未通过的项目记录原因、所缺资料和下一步，避免只凭演示观感判断。</p>'),
            ('next', '试跑结束后，带走什么', '<p>保留输入与输出样例、任务说明、运行条件和验收记录。适合继续时，内部团队确认首批岗位和部署范围；交付伙伴确认客户场景、集成边界与后续支持，再沟通商业授权和实施安排。</p><p><a href="/enterprise/">企业部署方案</a> · <a href="/developers/">二次开发指南</a> · <a href="/commercial-license/">商业授权范围</a></p>'),
        ],
        article=True,
    )
