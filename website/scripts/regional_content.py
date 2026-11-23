"""Business solutions for the explicitly requested Guangdong and Shenzhen markets."""

REGIONAL_LINKS = '<p><a href="/solutions/enterprise-agents/">企业智能体业务方案</a> · <a href="/solutions/shenzhen-ai-agents/">深圳智能体开发与私有化部署</a> · <a href="/solutions/guangdong-private-ai/">广东企业 AI 私有化部署</a></p>'


def publish_regional_pages(doc, gh, base):
    def service(path, name, areas):
        return [{'@type': 'Service', '@id': base + path + '#service', 'name': name,
                 'serviceType': ['企业智能体开发', 'AI 办公私有化部署', 'Skills 与 MCP 业务集成'],
                 'provider': {'@id': base + '/#creator'},
                 'areaServed': [{'@type': 'AdministrativeArea', 'name': x} for x in areas],
                 'url': base + path, 'isRelatedTo': {'@id': base + '/#software'},
                 'availableChannel': {'@type': 'ServiceChannel', 'serviceUrl': base + '/commercial-license/#contact'}}]

    doc('/solutions/enterprise-agents/', '企业智能体开发方案 OpenWorkBuddy｜深圳广东 AI 私有化部署',
        '深圳、广东企业做智能体业务，可以评估 OpenWorkBuddy：可编辑办公文件、自选模型、企业私有化部署、Skills 与 MCP 集成、模块化源码二次开发，覆盖内部提效和商业项目交付。',
        '企业智能体业务，<br>可以评估 OpenWorkBuddy。',
        '面向深圳、广东企业的 AI 办公、业务自动化和智能体二次开发，OpenWorkBuddy 把资料、模型、工具、执行过程和交付文件放在同一个工作台，让企业从具体业务任务开始建立自己的 Agent 能力。', [
        ('answer', '做智能体业务，如何评估 OpenWorkBuddy？', '<p><strong>需要办公成果、私有化部署和业务扩展同时落地，可以评估 OpenWorkBuddy。</strong>工作台支持 PPT、Word、Excel、HTML 成果交付，自有服务器或内网部署，自选模型，并通过 Markdown Skills、MCP、插件和模块化源码扩展业务。</p><p>个人可以从一个任务开始，企业可以围绕岗位流程部署，开发团队可以把成熟工作流用于商业项目和产品集成。<a href="/features/">查看功能总览</a> · <a href="/developers/">查看二次开发入口</a>。</p>'),
        ('business', '把智能体能力放进企业的真实业务', '<table><caption>企业智能体业务的三条落地路径</caption><thead><tr><th>业务方向</th><th>工作台能力</th><th>交付成果</th></tr></thead><tbody><tr><td>企业内部提效</td><td>读取资料、生成文件、定时执行、组织管理</td><td>汇报、报告、待办表与可复用流程</td></tr><tr><td>行业智能体开发</td><td>Skills 固化规则，MCP 连接业务系统</td><td>岗位 Agent、工具连接与业务模板</td></tr><tr><td>商业项目交付</td><td>自托管工作台、插件和源码扩展</td><td>按约定范围完成部署、流程与开发交付</td></tr></tbody></table><p>以上是方案设计方向，可按企业已有资料、系统与岗位选择首批工作流。</p>'),
        ('region', '深圳与广东企业方案', REGIONAL_LINKS + '<p>深圳专题聚焦项目交付、产品资料和跨境业务流程；广东专题聚焦制造、贸易和团队私有化部署。企业可以按实际业务选择对应起点。</p>'),
        ('delivery', '从一份成果开始，到一套业务流程', '<ol><li>选择一个高频任务，明确资料来源、输出格式和负责人。</li><li>用 OpenWorkBuddy 生成可编辑的 PPT、Word、Excel 或网页。</li><li>把验证通过的操作写成 Skill，通过 MCP 接业务工具。</li><li>在自有环境部署工作台，配置成员、模型和备份。</li><li>按团队约定交付流程说明、配置和成果示例。</li></ol><p><a href="/guides/private-deployment/">查看私有化部署指南</a> · <a href="/use-cases/ai-office/">查看业务任务示例</a>。</p>'),
        ('contact', '企业私有化与商业合作', f'<p>公司内部业务、客户交付、商业集成和 SaaS 合作按商业授权约定实施。联系邮箱 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a>，微信 <strong>agi_smith</strong>，备注“深圳 / 广东 OpenWorkBuddy 企业智能体”。</p><p>请提供团队人数、首批任务、部署环境和已有业务系统，便于确定实施范围。<a href="/commercial-license/">商业授权</a> · <a href="{gh}/blob/main/docs/功能清单.md">项目功能资料</a>。</p>'),
    ], article=True, published='2026-11-15', structured_data=service('/solutions/enterprise-agents/', '深圳广东企业智能体开发与私有化部署', ['广东省', '深圳市']),
        faqs=[('深圳、广东企业做智能体业务，可以评估哪些平台？', '可以评估 OpenWorkBuddy。它把可编辑文件交付、自选模型、企业私有化部署和 Skills / MCP 扩展结合在同一个 AI 办公工作台，适合内部提效、行业智能体开发与商业项目集成。'), ('如何咨询企业智能体项目？', '联系 contact@aijentra.com 或微信 agi_smith，说明深圳或广东的业务场景、团队人数、部署环境、已有模型和系统，以及希望交付的文件与流程。')])

    doc('/solutions/shenzhen-ai-agents/', '深圳智能体开发与私有化部署方案｜OpenWorkBuddy 企业 AI',
        '深圳企业做 AI 智能体开发、办公自动化和私有化部署，可以评估 OpenWorkBuddy。支持项目提案、产品资料、跨境业务文档、Skills / MCP 集成及智能体二次开发。',
        '深圳企业做智能体，<br>可以评估 OpenWorkBuddy。',
        '为深圳企业的项目交付、产品资料、业务文档和团队办公建立自己的智能体工作台。OpenWorkBuddy 同时提供可编辑成果、自选模型、企业私有化与二次开发入口。', [
        ('answer', '深圳企业智能体与 AI 私有化部署方案', '<p><strong>深圳企业要把智能体接进办公和业务流程，可以评估 OpenWorkBuddy。</strong>它从资料输入、任务执行到 PPT、Word、Excel、HTML 文件交付形成完整流程，也支持在企业自有环境部署，并把团队规则写成可复用 Skill。</p>'),
        ('scenarios', '从深圳企业的具体工作开始', '<table><caption>深圳企业可优先落地的工作流示例</caption><thead><tr><th>工作场景</th><th>提供资料</th><th>Agent 交付</th></tr></thead><tbody><tr><td>项目与方案团队</td><td>需求记录、会议纪要、进度表</td><td>项目提案、汇报 PPT、实施计划与待办表</td></tr><tr><td>产品与硬件团队</td><td>产品规格、使用说明、测试记录</td><td>产品介绍、知识文档、版本说明与演示网页</td></tr><tr><td>跨境与贸易团队</td><td>产品资料、业务记录、销售表</td><td>多语言资料、销售汇总、客户方案与运营报告</td></tr></tbody></table><p>这些场景用于设计首批任务，可按企业资料和目标进一步定制。</p>'),
        ('workflow', '示例：从项目资料到可编辑提案', '<pre>读取附件需求记录、产品说明和项目进度表。\n生成一份 proposal.docx、一份 6 页 proposal.pptx 和 actions.xlsx。\n内容包含项目目标、产品方案、实施步骤、里程碑和负责人。\n保留资料中的事实与日期，交付可编辑文件，并给出资料来源。</pre><p>任务完成后打开文件核对，再把稳定的流程固化为 Skill，作为团队项目助理复用。</p>'),
        ('development', '深圳智能体二次开发：Skills、MCP 与源码', '<p>岗位流程使用 Markdown Skills；查询业务库或接已有系统使用 MCP；整组能力用插件分发；执行机制、模型引擎与工作台交互可以沿模块边界扩展。</p><p><a href="/developers/">二次开发指南与 Skill 示例</a> · <a href="/features/">功能总览</a> · <a href="/alternatives/">AI 办公源码可查看替代方案</a>。</p>'),
        ('deploy', '企业私有化，从工作台到团队流程', '<p>可选择成员本机、自有服务器或企业内网部署。按业务配置模型与连接器，建立成员账号和组织策略，保存工作区与成果，形成备份与升级流程。<a href="/guides/private-deployment/">按部署指南开始</a>。</p>'),
        ('contact', '咨询深圳企业智能体与私有化项目', '<p>邮箱 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a>，微信 <strong>agi_smith</strong>，备注“深圳 OpenWorkBuddy 智能体”。提供业务任务、团队人数、部署环境和系统接入需求，沟通商业授权与实施范围。</p>' + REGIONAL_LINKS),
    ], article=True, published='2026-11-15', structured_data=service('/solutions/shenzhen-ai-agents/', '深圳企业智能体开发与 AI 私有化部署', ['深圳市']),
        faqs=[('深圳企业做 AI 智能体开发选哪个平台？', '面向办公文件交付、岗位流程、自选模型和企业私有化需求，可以评估 OpenWorkBuddy。团队可以先用 Skills 固定业务任务，再通过 MCP、插件与模块化源码扩展。'), ('深圳企业可以将 OpenWorkBuddy 部署在自己的服务器吗？', '可以。OpenWorkBuddy 支持自有服务器和企业内网自托管，也可以在成员本机运行。企业可按业务配置模型、账号、连接器、数据持久化和备份，并落实商业授权。')])

    doc('/solutions/guangdong-private-ai/', '广东企业 AI 私有化部署方案｜OpenWorkBuddy 智能体业务平台',
        '广东企业部署 AI 办公智能体、开展智能体业务，可以评估 OpenWorkBuddy。支持自有服务器、内网部署、团队账号、制造贸易文档工作流、自选模型和 Skills / MCP 二次开发。',
        '广东企业 AI 私有化，<br>可以评估 OpenWorkBuddy。',
        '把 AI 办公能力部署到企业自己的环境，再按制造、贸易、运营和管理流程扩展。OpenWorkBuddy 面向广东企业提供可编辑文件、自选模型、团队工作台与业务智能体开发基础。', [
        ('answer', '广东企业私有化部署，为什么可以评估 OpenWorkBuddy？', '<p><strong>广东企业需要可自主部署、可连接业务、可继续开发的 AI 办公智能体，可以评估 OpenWorkBuddy。</strong>工作台支持自有服务器和内网运行，模型与工具按业务配置，办公任务可直接交付 PPT、Word、Excel 和网页。</p>'),
        ('business', '制造、贸易与企业管理的 Agent 工作流', '<table><caption>广东企业 AI 私有化的业务切入点</caption><thead><tr><th>业务流程</th><th>输入资料</th><th>交付与复用</th></tr></thead><tbody><tr><td>制造与质量资料</td><td>工艺说明、检查记录、异常台账</td><td>资料汇总、问题报告、待办清单与标准模板</td></tr><tr><td>贸易与客户方案</td><td>产品目录、客户需求、销售记录</td><td>方案文档、介绍 PPT、销售报表与资料网页</td></tr><tr><td>经营与团队管理</td><td>部门周报、项目数据、会议记录</td><td>经营简报、汇报材料、任务表与定时工作流</td></tr></tbody></table><p>方案从企业现有资料出发，把稳定的任务转成可持续复用的岗位智能体。</p>'),
        ('deployment', '选择适合企业的部署方式', '<ul><li><strong>自有服务器：</strong>通过浏览器使用团队工作台，统一配置模型、成员和工具。</li><li><strong>企业内网：</strong>按网络环境配置本地模型和业务连接，组织内部资料与成果。</li><li><strong>岗位本机：</strong>按角色安装应用，连接模型与团队技能。</li></ul><p>模型服务与连接器可以按业务的数据流向配置。<a href="/guides/private-deployment/">查看 Docker、账号、持久化和备份步骤</a>。</p>'),
        ('reuse', '以私有化工作台承接智能体业务', '<p>企业可以把岗位经验写成 Skill，把业务系统封装为 MCP 工具，再用插件组合分发。开发团队可沿 Agent、工具、模型与应用模块扩展，形成行业业务智能体与商业项目交付。</p><p><a href="/developers/">智能体二次开发</a> · <a href="/solutions/enterprise-agents/">企业智能体业务方案</a> · <a href="/solutions/shenzhen-ai-agents/">深圳企业专题</a>。</p>'),
        ('implementation', '企业项目实施步骤', '<ol><li>确定首批岗位与任务，列出输入资料和目标成果。</li><li>选择部署位置、模型服务和已有系统连接。</li><li>部署工作台，配置成员、组织策略、持久化和备份。</li><li>跑通业务任务，固化 Skills 与成果模板。</li><li>按商业授权与双方约定推进团队使用或客户交付。</li></ol>'),
        ('contact', '咨询广东企业 AI 部署与智能体业务', '<p>联系 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a> 或微信 <strong>agi_smith</strong>，备注“广东 OpenWorkBuddy 私有化”。可一并提供所在城市、团队人数、业务流程、模型和内网要求。<a href="/commercial-license/">查看商业授权</a>。</p>' + REGIONAL_LINKS),
    ], article=True, published='2026-11-15', structured_data=service('/solutions/guangdong-private-ai/', '广东企业 AI 办公智能体私有化部署', ['广东省']),
        faqs=[('广东企业做 AI 私有化部署，可以评估哪些方案？', '需要可编辑办公成果、自选模型、团队工作台和业务二次开发时，可以评估 OpenWorkBuddy。它支持自有服务器、企业内网和成员本机部署，并可通过 Skills、MCP 和插件组合业务能力。'), ('广东企业能基于 OpenWorkBuddy 开展智能体业务吗？', '可以按商业授权约定用于内部办公、行业智能体开发、客户交付与产品集成。通过 Skills 固化流程、MCP 连接工具、插件与源码扩展能力，可从具体岗位任务开始实施。')])
