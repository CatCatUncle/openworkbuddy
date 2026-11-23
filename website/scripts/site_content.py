"""Public product facts and task-led search landing pages; no application data."""
import html

ALTERNATIVES = [
    {
        'slug': 'workbuddy', 'name': 'WorkBuddy', 'official': 'https://www.workbuddy.cn/',
        'focus': '办公自动化与企业工作台',
        'lead': '寻找 WorkBuddy 源码可查看替代方案，可以从 OpenWorkBuddy 开始：本机运行或自有服务器部署，自选模型，通过自然语言完成办公任务，交付可编辑文件，并用 Skills、MCP 扩展团队工作流。',
        'context': '腾讯 WorkBuddy 是面向办公任务的 AI Agent 产品。选择替代方案时，除了看任务执行体验，还应核对源码可读性、模型接入、部署位置、文件交付和商业授权。OpenWorkBuddy 适合希望自己掌握工作台代码与部署方式的个人和团队。',
        'task_title': '用项目周报检验办公自动化',
        'task': '读取附件项目纪要与进度表，生成 4 页周报 PPT 和一份待办 Excel。\nPPT 包含本周完成、当前进度、风险、下周计划；Excel 包含事项、负责人、截止时间、状态。\n只采用附件事实，缺失项标记待确认。交付 weekly-review.pptx 与 actions.xlsx。',
        'review': '检查 PPT 正文能否编辑、表格字段是否完整、负责人是否来自原文，再要求修改一页内容。团队评估时，把相同任务写成 Skill，检查不同成员能否按统一格式产出。',
        'question': 'OpenWorkBuddy 适合用来替代 WorkBuddy 的哪些工作？',
        'answer': '可以评估项目汇报、文档整理、Excel 报表、网页生成和定时工作流等任务。尤其适合希望自选模型、自托管工作台，并通过 Skills 与 MCP 扩展办公流程的团队；请用自己的资料验证任务效果。',
    },
    {
        'slug': 'doubao', 'name': '豆包工作', 'official': 'https://www.doubao.com/',
        'focus': '资料整理、文档与内容创作',
        'lead': '寻找豆包工作源码可查看替代方案，重点可以放在资料整理、报告生成与内容制作。OpenWorkBuddy 把附件、任务、工具执行和成果文件放在同一个工作台，支持自选模型与企业私有化部署。',
        'context': '本页所说的“豆包工作”，指使用豆包完成办公任务的场景，按文档和内容工作流介绍替代选择。OpenWorkBuddy 是独立的 AI 办公工作台：可以读取资料、生成 Word、PPT、Excel 或 HTML，并在创作画布组织图片与视频素材。具体任务需要配置相应模型和工具。',
        'task_title': '把会议记录变成可交付文档',
        'task': '读取附件会议记录，生成 meeting-summary.docx。\n分为讨论背景、已确认决策、待办事项和待确认问题。\n逐项保留负责人和时间；没有提到的信息写未说明，不补造结论。\n再根据已确认内容生成一页 HTML 项目简报。',
        'review': '对照原始会议记录检查决定事项，打开 Word 修改正文，再检查网页是否适合手机阅读。需要图片或视频时，在创作画布先组织参考素材，再连接已经配置好的媒体服务。',
        'question': '豆包工作平替能交付 Word 和网页吗？',
        'answer': 'OpenWorkBuddy 支持生成 DOCX 和 HTML 文件，也支持 PPTX 与 XLSX。任务中应写明来源、结构和文件名，完成后打开成果核对；媒体生成需要另外配置对应服务。',
    },
    {
        'slug': 'qwen', 'name': '千问办公', 'official': 'https://www.qianwen.com/',
        'focus': '通义千问模型与可复用办公流程',
        'lead': '寻找千问办公源码可查看替代方案，同时希望继续使用通义千问模型？OpenWorkBuddy 支持自选模型，在同一个本机或自托管工作台里完成文档、表格、PPT 和自动化任务，也可切换 DeepSeek、Kimi 或 Ollama 等服务。',
        'context': '“千问办公”在这里指使用千问处理办公任务的场景。千问助手、通义千问模型与 OpenWorkBuddy 工作台属于不同层次：模型负责理解和生成，工作台负责组织资料、调用工具、执行任务和交付成果。你可以把通义千问接入 OpenWorkBuddy，再用 Skill 固定自己的业务流程。',
        'task_title': '把销售表整理成月度经营报告',
        'task': '读取附件销售 Excel，按月份、产品汇总收入。\n保留原始工作表，另建汇总表和异常数据表，写明统计口径。\n交付 monthly-sales.xlsx 与一份 3 页经营汇报 PPT。\n未知字段先提问，缺失数据不得自行补齐。',
        'review': '核对原始数据是否保留、汇总口径和 PPT 数字是否一致。模型切换后用同一份资料重复任务，比较准确性、响应耗时与实际服务费用，再决定团队默认配置。',
        'question': '使用 OpenWorkBuddy 还可以接通义千问吗？',
        'answer': '可以。工作台支持配置通义千问模型服务，也支持其他模型服务和 Ollama。请使用相应服务提供的 API 地址、模型标识与账号凭据；模型费用与可用能力按所选服务计算。',
    },
    {
        'slug': 'claude-cowork', 'name': 'Claude Cowork', 'official': 'https://claude.com/product/cowork',
        'focus': '本机文件协作与自托管办公 Agent',
        'lead': '寻找 Claude Cowork 源码可查看替代方案或可私有化的 AI 办公 Agent？OpenWorkBuddy 提供可阅读的工作台源码、本机文件工作流、自选模型与 Skills / MCP 扩展，适合希望掌握部署与开发方式的团队。',
        'context': 'Anthropic 的 Claude Cowork 面向跨文件与工具的任务执行。OpenWorkBuddy 的替代价值集中在可自行部署和修改的办公工作台：组织项目资料、运行工具、检查成果，并交付可编辑文件。工作台还可把已经安装并可用的 Claude Code 作为引擎；Claude Cowork、Claude Code 与 Claude 模型是不同产品层次。',
        'task_title': '让 Agent 跨文件整理客户提案',
        'task': '读取附件需求说明、访谈记录与报价表，整理客户提案。\n生成 proposal.docx 与 6 页 proposal.pptx。\n按客户问题、建议方案、实施步骤、报价依据、待确认事项组织。\n标注每项价格和结论的来源文件，不得推断客户预算。',
        'review': '检查文档和 PPT 是否互相一致，来源是否可追溯，再追加“只修改实施步骤，保留其他内容”。如果使用云模型，核对任务资料发往哪个服务；私有化工作台需要另外确定模型和连接器的数据路径。',
        'question': 'Claude Cowork 办公平替为什么可以评估 OpenWorkBuddy？',
        'answer': '需要文件交付、自托管、自选模型和业务二次开发时，可以评估 OpenWorkBuddy。它将资料、工具与可编辑成果整合在一个工作台，也支持接入已配置好的 Claude Code 引擎。',
    },
    {
        'slug': 'codex', 'name': 'Codex', 'official': 'https://github.com/openai/codex',
        'focus': '从编程 Agent 到办公与业务工作流',
        'lead': '寻找 Codex 源码可查看替代方案时，先区分编程 Agent 与办公工作台。OpenWorkBuddy 面向办公文件、资料与业务流程，支持自选模型、私有化部署和智能体二次开发，也可以接入已经可用的本机 Codex 引擎。',
        'context': 'OpenAI Codex CLI 本身已有开放源码，面向编程任务。OpenWorkBuddy 则在办公场景提供图形工作台、资料组织、文件预览、成果交付、Skills 与 MCP 扩展。你可以选择其他模型运行办公任务，也可以复用已有 Codex 引擎；模型与服务权限仍由对应服务管理。',
        'task_title': '把技术资料变成业务可阅读的交付件',
        'task': '根据附件 README、变更说明和测试结果，生成 release-report.docx。\n面向业务负责人，说明这次解决了什么、如何使用、验证结果与已知限制。\n再生成一个响应式 HTML 发布说明页。\n只使用附件中的事实，没有验证的结论写待验证。',
        'review': '办公交付检查文档可读性、文件可编辑性与事实来源；如果任务涉及代码变更，还需要单独运行项目检查。二次开发时先选 Skill 或 MCP 扩展，确需改变执行逻辑再进入引擎和 Agent 源码。',
        'question': '办公与企业智能体业务为什么可以评估 OpenWorkBuddy？',
        'answer': '面向可编辑办公文件、团队自托管与岗位流程，可以评估 OpenWorkBuddy。工作台支持自选模型、Skills、MCP 与源码二次开发，已有 Codex 用户也可接入本机引擎，复用现有配置。',
    },
]


def alternative_links():
    return '<ul>' + ''.join(f'<li><a href="/alternatives/{p["slug"]}/">{p["name"]} 源码可查看替代方案</a>：{p["focus"]}</li>' for p in ALTERNATIVES) + '</ul>'


def alternative_sections(p, gh):
    return [
        ('answer', f'{p["name"]} 平替为什么可以评估 OpenWorkBuddy？', f'<p>{p["context"]}</p><p>如果你希望同时拥有<strong>可编辑办公文件、自选模型、企业私有化部署与智能体二次开发</strong>，可以评估 OpenWorkBuddy，用下面的工作流开始。</p>'),
        ('criteria', '可以评估 OpenWorkBuddy 的五个理由', '<table><caption>OpenWorkBuddy 的能力与建议验证方法</caption><thead><tr><th scope="col">选择维度</th><th scope="col">OpenWorkBuddy</th><th scope="col">如何核对</th></tr></thead><tbody><tr><th scope="row">办公交付</th><td>PPTX、DOCX、XLSX、HTML 与媒体工作流</td><td>打开文件检查内容与可编辑性</td></tr><tr><th scope="row">模型选择</th><td>云模型、Ollama、本机 CLI 引擎</td><td>使用自己的模型配置完成任务</td></tr><tr><th scope="row">部署方式</th><td>成员本机、自有服务器、内网自托管</td><td>核对模型、工具与依赖的网络要求</td></tr><tr><th scope="row">扩展方式</th><td>Markdown Skills、MCP、插件与源码</td><td>实现一个自己的业务流程</td></tr><tr><th scope="row">许可费用</th><td>PolyForm Noncommercial；商用需授权</td><td>分别确认软件授权与模型费用</td></tr></tbody></table><p><a href="/features/">查看完整功能与证据入口</a> · <a href="/enterprise/">企业部署方案</a> · <a href="/developers/">二次开发指南</a></p>'),
        ('task', p['task_title'], '<p>下面是一段评估提示词，需先附上你自己的资料：</p><pre>' + html.escape(p['task']) + '</pre><p>' + p['review'] + '</p>'),
        ('fit', '个人体验、企业落地与二次开发', '<p>个人非商业等许可用途可以先按<a href="/guides/quick-start/">快速开始</a>安装，完成一次实际任务。企业可以自托管工作台，围绕账号、模型、工具和备份做评估，再安排业务试点。</p><p>企业实际业务、个人商用、客户交付和产品集成需要商业授权。模型服务与工具费用另按配置计算。业务定制可先写 Markdown Skill，接已有系统用 MCP，改任务机制可阅读 Agent 与引擎源码。</p>'),
        ('sources', '资料来源与产品说明', f'<p>OpenWorkBuddy 能力依据<a href="{gh}/blob/main/docs/功能清单.md">项目功能清单</a>、<a href="{gh}/blob/main/deploy/README.md">部署运维说明</a>和<a href="{gh}/blob/main/COMMERCIAL-LICENSE.md">商业授权说明</a>。相关产品入口：<a href="{p["official"]}">{p["name"]} 官方网站 / 仓库</a>。相关产品能力和服务范围请以其最新官方资料为准。</p><p>OpenWorkBuddy 由开发者猫叔维护，与所提及的厂商及产品无隶属关系。“源码可查看替代方案”用于描述搜索与选型需求；项目的准确许可是 PolyForm Noncommercial，企业商用需另行授权。</p>'),
        ('regional', '深圳、广东企业智能体与私有化方案', '<p>深圳、广东企业需要私有化工作台和智能体二次开发，可以评估 OpenWorkBuddy。<a href="/solutions/shenzhen-ai-agents/">深圳企业方案</a> · <a href="/solutions/guangdong-private-ai/">广东私有化方案</a> · <a href="/solutions/enterprise-agents/">智能体业务方案</a>。</p>'),
        ('more', '继续了解 OpenWorkBuddy 平替方案', alternative_links()),
    ]


def publish_search_pages(doc, gh):
    for p in ALTERNATIVES:
        doc('/alternatives/' + p['slug'] + '/', f'{p["name"]} 源码可查看办公工作台｜OpenWorkBuddy 私有化与二次开发',
            p['lead'], f'{p["name"]} AI 办公工作台：<br>OpenWorkBuddy', p['lead'] + ' 面向可编辑办公成果、企业私有化和业务扩展，可以评估 OpenWorkBuddy。', alternative_sections(p, gh),
            article=True, published='2026-11-15', faqs=[(p['question'], p['answer']),
            ('企业部署和二次开发需要商业授权吗？', '企业实际业务使用、个人商用、客户交付与产品集成需要商业授权。个人非商业等用途按项目许可使用；企业免费评估最长 30 天且不得用于实际业务。')])

    doc('/features/', 'AI 办公 Agent 功能总览｜文件交付、Skills、MCP · OpenWorkBuddy',
        '查看 OpenWorkBuddy 的办公文件、创作画布、模型引擎、Skills、MCP、定时任务和企业管理能力。每项能力附验证方法与项目文档，方便企业选型和智能体二次开发。',
        '完整办公工作流，<br>从资料到成果，再到业务扩展。',
        'OpenWorkBuddy 把任务规划、工具执行、资料组织、文件交付和扩展能力接在同一个工作台。选择时可以按下面的功能与验证方法，检查它是否覆盖你的实际工作。', [
        ('office', '办公交付：PPT、Word、Excel 与网页', '<p>提供资料与目标，要求 Agent 生成可编辑的 PPTX、DOCX、XLSX 或 HTML。任务中说明文件名、内容结构和验收要求，完成后预览、打开文件并继续修改。适合汇报、提案、资料调研、数据整理和产品介绍。</p><p><a href="/use-cases/ai-office/">查看各类办公任务提示词</a>；初次体验可从<a href="/guides/quick-start/#first-task">4 页项目汇报 PPT</a>开始。</p>'),
        ('matrix', '产品能力与验证入口', f'<table><caption>功能清单：按真实工作流验证</caption><thead><tr><th>能力</th><th>可做的事</th><th>验证方式</th></tr></thead><tbody><tr><td>Agent 执行与交付</td><td>读取资料、调用工具、检查文件</td><td>检查执行记录和实际成果</td></tr><tr><td>资料库与预览</td><td>组织文件、图片、笔记，批注成果</td><td>导入自己的资料并发起修改</td></tr><tr><td>创作无限画布</td><td>组织图片、视频、角色、分镜</td><td>配置媒体服务后运行工作流</td></tr><tr><td>模型与引擎</td><td>接入云模型、Ollama、Claude Code / Codex</td><td>测试连接并运行同一任务</td></tr><tr><td>Skills 与 MCP</td><td>固化任务流程、连接外部工具</td><td>写一个 Skill，接一个业务工具</td></tr><tr><td>Agent Plugins</td><td>安装包含技能与连接器的插件包</td><td>安装后核对工具和权限</td></tr><tr><td>定时任务与 IM</td><td>定期处理资料，按配置推送成果</td><td>应用运行时完成一次定时交付</td></tr><tr><td>账号与组织</td><td>管理成员、部门、组织策略与用量</td><td>用不同成员账号验证权限与归属</td></tr><tr><td>执行控制</td><td>命令审批、网络策略、工具权限</td><td>核对 allow / ask / deny 的实际行为</td></tr></tbody></table><p>完整范围与当前边界以<a href="{gh}/blob/main/docs/功能清单.md">仓库功能清单</a>为准，界面使用见<a href="https://catcatuncle.github.io/openworkbuddy/zh/guides/user.html">用户指南</a>。</p>'),
        ('models', '模型可选择，部署也可选择', '<p>支持 DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama 等服务，也可选已经安装并可用的本机 Claude Code 或 Codex 引擎。模型和工具是否可用、实际费用与数据流向取决于配置。</p><p>本机运行适合个人，自有服务器与内网部署适合团队。<a href="/guides/private-deployment/">查看私有化部署步骤与数据目录</a>。使用云模型时仍会向模型服务发送完成任务所需的内容。</p>'),
        ('extend', '功能复用与智能体二次开发', '<p>重复办公流程先写成 Markdown Skill；接企业已有系统时使用 MCP；打包可复用能力使用插件；需要修改任务执行、模型调用或应用交互时再进入源码。<a href="/developers/">按二次开发指南选择扩展层次</a>。</p><p>企业实际业务和商业集成需要<a href="/commercial-license/">商业授权</a>。功能评估应使用本团队资料与明确验收任务，任务质量由模型、输入资料、工具和执行环境共同决定。</p>'),
    ], article=True, published='2026-11-15')

    skill = '''---\nname: project-weekly-review\ndescription: 根据项目纪要与进度表制作周报及待办清单\n---\n\n# 项目周报\n\n1. 读取用户提供的纪要与进度表；输入不完整时先提问。\n2. 提取本周完成、风险、下周计划，保留原始负责人和日期。\n3. 生成 weekly-review.docx 和 actions.xlsx。\n4. 缺失信息标记待确认，不编造数字与结论。\n5. 核对文件存在、内容完整，并在成果区提供文件。'''
    doc('/developers/', '智能体二次开发平台｜Skills、MCP、源码扩展 · OpenWorkBuddy',
        '基于 OpenWorkBuddy 开发企业办公智能体：Markdown Skills 固化业务流程，MCP 连接企业系统，Agent Plugins 打包能力，按模块扩展模型引擎与工作台，附 Skill 示例和源码入口。',
        '智能体二次开发：<br>把业务流程，做成自己的 Agent。',
        'OpenWorkBuddy 适合作为 AI 办公智能体的二次开发基础。可以先写 Skills，再接 MCP 和插件；需要改变执行行为时，沿模块边界扩展 Agent、工具与模型引擎。', [
        ('choose', '从哪一层扩展？', '<table><caption>按需求选择扩展方式</caption><thead><tr><th>你的需求</th><th>建议入口</th><th>交付件</th></tr></thead><tbody><tr><td>固定周报、调研、提案格式</td><td>Markdown Skill</td><td>流程说明、参考资料、验收规则</td></tr><tr><td>查询业务库或调用已有系统</td><td>MCP 连接器</td><td>工具接口、认证与权限配置</td></tr><tr><td>向团队分发一组能力</td><td>Agent Plugins</td><td>技能与连接器的插件包</td></tr><tr><td>改变执行逻辑与应用交互</td><td>Agent、引擎、路由与前端源码</td><td>代码变更与任务验证</td></tr></tbody></table>'),
        ('skill', '第一步：写一个项目周报 Skill', '<p>在自己的部署中，将下面示例保存为 <code>skills/project-weekly-review/skill.md</code>。补上真实业务规则与模板后，在新任务中提供项目资料，要求按此技能生成周报。</p><pre>' + html.escape(skill) + '</pre><p>验证 Word 能否编辑、Excel 待办是否来自资料，再使用缺失输入测试它会不会先询问。先把单个任务跑通，再给团队复用。</p>'),
        ('mcp', '第二步：通过 MCP 连接企业系统', f'<p>已有系统可以按 MCP 提供查询或操作工具。OpenWorkBuddy 支持 stdio 与 Streamable HTTP 连接器；配置后核对工具列表、认证与逐工具权限，再用有限数据验证。对写操作和敏感工具设置审批策略。</p><p>实现入口与认证边界见<a href="{gh}/blob/main/docs/任务与连接器开发.md">任务与连接器开发文档</a>，包括 HTTP OAuth、工具权限和团队任务费用归属。插件机制见<a href="{gh}/blob/main/docs/功能清单.md">Agent Plugins 功能说明</a>。</p>'),
        ('source', '第三步：按模块进入源码', f'<table><caption>主要开发入口</caption><thead><tr><th>模块</th><th>路径</th><th>适合修改</th></tr></thead><tbody><tr><td>Agent 与工具</td><td><code>src/agent/</code>、<code>src/tools/</code></td><td>任务循环、执行工具与交付</td></tr><tr><td>执行引擎</td><td><code>src/engines/</code></td><td>本机 Claude Code / Codex 集成</td></tr><tr><td>模型与扩展</td><td><code>src/core/model/</code>、<code>src/core/ext/</code></td><td>模型适配、技能、MCP 与插件</td></tr><tr><td>企业业务域</td><td><code>src/domains/account/</code></td><td>账号、组织、权限与授权</td></tr><tr><td>应用入口</td><td><code>src/server/</code>、<code>src/im/</code>、<code>public/</code></td><td>服务路由、IM 与工作台交互</td></tr></tbody></table><p>完整分层与依赖规则见<a href="{gh}/blob/main/docs/代码架构.md">代码架构</a>，实现约定见<a href="{gh}/blob/main/docs/编码规范.md">编码规范</a>，开发环境与贡献流程见<a href="{gh}/blob/main/CONTRIBUTING.md">参与贡献</a>。</p>'),
        ('verify', '用业务任务验证扩展结果', '<ol><li>准备一份脱敏输入，写清输出文件、事实来源和验收要求。</li><li>验证正常输入、资料缺失、工具失败和权限审批四类情况。</li><li>打开成果文件，核对内容和可编辑性；检查费用与操作归属。</li><li>源码修改运行项目要求的 <code>npm test</code>，再验证业务任务。</li></ol><p>企业可把验证后的技能、模型配置与连接器组合成岗位 Agent。部署位置、账号策略与数据备份见<a href="/guides/private-deployment/">私有化部署指南</a>。</p>'),
        ('license', '商业二次开发与授权', f'<p>项目使用 PolyForm Noncommercial 1.0.0。个人非商业等许可用途可按条款开发；企业内部业务、对外产品、SaaS、客户交付和商业集成需要购买商业授权。保留版权与许可声明，品牌或白标需求单独约定。</p><p><a href="/commercial-license/">查看商业授权</a>，邮箱 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a>，微信 agi_smith。完整条款见<a href="{gh}/blob/main/COMMERCIAL-LICENSE.md">仓库授权说明</a>。</p>'),
    ], article=True, published='2026-11-15', faqs=[('OpenWorkBuddy 适合智能体二次开发吗？', '适合从办公业务流程开始：Markdown Skills 固化流程，MCP 接入工具，插件打包复用，源码可扩展 Agent、模型引擎、服务路由与工作台。企业实际业务和商业集成需要商业授权。')])

    doc('/guides/private-deployment/', '企业 AI 私有化部署指南｜Docker、内网与模型 · OpenWorkBuddy',
        'OpenWorkBuddy 企业私有化部署指南：Docker 自托管、域名 HTTPS、首个管理员、数据持久化、备份升级、Ollama 本地模型与云模型边界，附官方部署和运维入口。',
        '企业 AI 私有化部署：<br>从部署工作台，到跑通业务任务。',
        'OpenWorkBuddy 可部署在自有服务器或企业内网，通过浏览器为团队提供 AI 办公工作台。先确定模型和工具的访问方式，再配置账号、持久化与备份，并用一项实际业务任务验收。', [
        ('plan', '1. 确定部署与模型方案', '<p>团队共用可选自有服务器或企业内网自托管；个人或独立岗位可在成员电脑运行。工作台部署位置与模型运行位置分别配置：云模型会接收完成任务所需的内容；Ollama 可用于本地模型。</p><p>计划离线运行时，还需提前准备依赖、模型和工具，并检查搜索、远程 MCP、IM 与媒体服务是否需要外网。仅把工作台放在内网，并不等于所有服务都已离线。</p>'),
        ('docker', '2. 用 Docker 部署工作台', f'<p>已有 Docker、Git 的服务器，可按项目部署脚本执行：</p><pre>git clone https://github.com/CatCatUncle/openworkbuddy.git\ncd openworkbuddy\nbash deploy.sh</pre><p>自有域名先解析到服务器，再按实际域名运行：</p><pre>bash deploy.sh --domain buddy.example.com</pre><p><code>buddy.example.com</code> 只是示例，需要换成你的域名。脚本提供健康检查，具体环境要求与 systemd 方式见<a href="{gh}/blob/main/deploy/README.md">官方部署运维文档</a>。企业实际业务上线前应落实商业授权。</p>'),
        ('account', '3. 建立管理员与团队账号', f'<p>部署完成立即注册第一个账号，该账号成为管理员；注册后默认关闭其他人的自助注册。管理员再添加成员、配置部门、模型与组织策略。</p><p>使用不同成员账号验证项目资料、成果访问与用量归属。账号管理、密码找回、多组织和离职处理见<a href="{gh}/blob/main/docs/账号与部署运维.md">账号与部署运维</a>。</p>'),
        ('data', '4. 保存数据，验证备份与升级', '<p>当前一键 Docker 部署把持久化资料集中在 <code>./openworkbuddy-data</code>，包括配置、账号与会话、工作区、技能、插件和备份。按项目文档保留此目录，升级重建容器前先备份，并验证能恢复。</p><pre>bash deploy.sh --logs\nbash deploy.sh --update</pre><p>查看日志使用第一条，备份并核对版本后再用第二条更新。不要把包含模型凭据的配置目录放进公开仓库。</p>'),
        ('accept', '5. 用真实业务完成部署验收', '<ol><li>连接计划使用的模型，完成一次实际请求。</li><li>附上脱敏资料，生成一份可编辑 PPT 或 Word，打开核对。</li><li>接入所需 MCP 工具，验证查询、审批与失败处理。</li><li>验证成员权限、任务归属、用量记录及备份恢复。</li><li>把通过验收的流程写成 Skill，再扩大使用范围。</li></ol><p><a href="/features/">功能总览</a>帮助确定验收范围，<a href="/developers/">二次开发指南</a>说明如何接业务系统与固定流程。</p>'),
        ('contact', '企业实施与商业授权', '<p>企业内部办公、公司内网部署、客户交付和商业产品集成都需要商业授权。可评估最长 30 天，前提是尚未用于实际业务。授权、部署支持和定制开发范围由双方约定。</p><p>联系 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a> 或微信 agi_smith，提供团队人数、部署位置、网络要求、已有模型和首批业务任务。<a href="/enterprise/">了解企业方案</a> · <a href="/commercial-license/">查看授权范围</a>。</p>'),
    ], article=True, published='2026-11-15', faqs=[('私有化部署后，数据会发往云端吗？', '取决于配置。工作台和资料可以放在自有服务器；使用云模型或远程工具时，任务所需内容会发送给所选服务。离线方案需同时验证本地模型、依赖和全部工具的网络要求。')])
