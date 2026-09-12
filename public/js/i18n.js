/* OpenWorkBuddy 界面语言
 *
 * 中文是源文：代码和模板里照旧写中文。英文是一本词典（中文原句 → 英文）。
 * 不引入 key 体系——`t("保存")` 直接拿中文当键；词典里没有的原样显示中文，
 * 漏翻的地方一眼能看见，不会变成 undefined 或空白。
 *
 * 两条路：
 *  1. 静态/模板文字：页面渲染后由 apply() 走一遍 DOM 翻文本节点和
 *     placeholder/title/aria-label/alt；英文模式下挂 MutationObserver，
 *     之后再渲染出来的节点也自动翻。每个节点记住原文，切回中文能原样恢复。
 *  2. 内容区不碰：AI 回复（.a-text）、用户消息（.bubble）、代码/预览，
 *     用 translate="no" 或 data-i18n-skip 标出来，整棵子树跳过。
 *
 * AI 回复语言不在这里管：前端把 lang 随 /api/chat 发给服务端，服务端塞进系统提示词。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.I18N = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  const LANGS = { zh: "中文", en: "English" };
  const STORE_KEY = "wb-lang";

  // ---------- 词典：中文原句 → 英文 ----------
  const DICT = {
    en: {
      // 壳：侧栏 / 顶栏 / 输入区（index.html）
      "下载": "Download",
      "专家": "Experts",
      "关闭": "Close",
      "发送": "Send",
      "插队": "Interject",
      "更多": "More",
      "模型": "Model",
      "登录": "Sign in",
      "设置": "Settings",
      "评测": "Evals",
      "项目": "Projects",
      "新任务": "New task",
      "用户名": "Username",
      "自动化": "Automation",
      "资料库": "Library",
      "任务历史": "Task history",
      "助理模式": "Assistant",
      "回到最前": "Jump to top",
      "回到最新": "Jump to latest",
      "团队协作": "Teams",
      "成果文件": "Output files",
      "新建任务": "New task",
      "新建项目": "New project",
      "本地任务": "Local task",
      "注册一个": "Create one",
      "账号菜单": "Account menu",
      "项目管理": "Projects",
      "参考模板库": "Templates",
      "打开文件夹": "Open folder",
      "提示词范例": "Prompt examples",
      "自动改文件": "Edit files for me",
      "打开所在位置": "Reveal in folder",
      "还没有账号？": "No account yet?",
      "选择工作空间": "Choose workspace",
      "IM 远程指挥": "Remote control via IM",
      "收起/展开侧栏": "Toggle sidebar",
      "知识 · 灵感": "Knowledge · Ideas",
      "Ask · 问答": "Ask · Q&A",
      "只读问答不改文件": "Answer only, no file changes",
      "技能 · 连接器": "Skills · Connectors",
      "资料库 · 灵感": "Library · Ideas",
      "Goal · 目标": "Goal · Objective",
      "Plan · 规划": "Plan · Planning",
      "只出执行计划不动手": "Plan only, no execution",
      "完整执行并交付成果": "Execute fully and deliver",
      "定时 · 运行记录": "Schedules · Run log",
      "用系统默认程序打开": "Open with default app",
      "Craft · 执行": "Craft · Execute",
      "密码（至少 6 位）": "Password (6+ characters)",
      "登录后使用你自己的任务历史": "Sign in to keep your own task history",
      "拆解验收标准，没达成自动再跑": "Break into acceptance criteria, rerun until met",
      "跑分 · AI 评委 · 人工打分": "Benchmarks · AI judge · Manual scores",
      "上传文件到工作空间，任务中可直接使用": "Upload files to the workspace for tasks to use",
      "开源版 · 一句话让 AI 替你上班": "Open source · One sentence, AI does the work",
      "助理模式：IM 远程指挥 + 直接对话": "Assistant mode: remote control via IM + direct chat",
      "不等当前任务结束，把这条消息立即注入正在执行的任务": "Inject this message into the running task right now, without waiting for it to finish",
      "今天帮你做些什么？@ 引用文件，/ 调用技能与指令": "What shall I do today? @ to reference files, / for skills and commands",

      // 通用按钮 / 短标签
      "保存": "Save",
      "加载中…": "Loading…",
      "取消": "Cancel",
      "删除": "Delete",
      "复制": "Copy",
      "头像": "Avatar",
      "编辑": "Edit",
      "修改": "Change",
      "安装": "Install",
      "删": "Del",
      "时间": "Time",
      "移除": "Remove",
      "每天": "Daily",
      "恢复默认": "Reset to default",
      "拖动调整侧栏宽度": "Drag to resize the sidebar",
      "拖动调整预览面板宽度": "Drag to resize the preview panel",
      "拖动调整成果文件面板宽度": "Drag to resize the output files panel",
      "拖动调整宽度 · 双击恢复默认": "Drag to resize · double-click to reset",
      "搜索服务商": "Search providers",
      "AI 评委": "AI judge",
      "导入为条目": "Import as entries",
      "复制失败": "Copy failed",
      "运行记录": "Run log",
      "并入背景说明": "Merge into background notes",
      "帮助与反馈": "Help & feedback",
      "定时任务": "Scheduled tasks",
      "不花 API 额度": "No API quota used",
      "本机 Claude Code": "Local Claude Code",
      "本机 Codex": "Local Codex",
      "先把要导入的内容粘进来": "Paste what you want to import first",
      "Jina（国内直连 · 免费额度）": "Jina (works in China · free tier)",
      "Brave Search（要绑卡）": "Brave Search (card required)",
      "Tavily（推荐 · 免费额度 · 不用绑卡）": "Tavily (recommended · free tier · no card)",
      "记下": "Note it",
      "停止": "Stop",
      "拒绝": "Deny",
      "昵称": "Nickname",
      "充值": "Top up",
      "类型": "Type",
      "用户": "User",
      "来源": "Source",
      "积分": "Credits",
      "返回": "Back",
      "当前": "Current",
      "指令": "Instructions",
      "确定": "OK",
      "全选": "Select all",
      "周一": "Mon",
      "周二": "Tue",
      "周三": "Wed",
      "周四": "Thu",
      "周五": "Fri",
      "周六": "Sat",
      "周日": "Sun",
      "收起": "Collapse",
      "展开": "Expand",
      "任务": "Task",
      "触发": "Trigger",
      "耗时": "Duration",
      "结果": "Result",
      "空表": "Empty sheet",
      "最近": "Recent",
      "解散": "Disband",
      "官方": "Official",
      "名字": "Name",
      "花名": "Alias",
      "可空": "optional",
      "分类": "Category",
      "插件": "Plugins",
      "正文": "Body",
      "遵循": "Follows",
      "更新": "Update",
      "卸载": "Uninstall",
      "前移": "Move up",
      "名称": "Name",
      "命令": "Command",
      "地址": "URL",
      "形象": "Look",
      "大小": "Size",
      "恢复": "Restore",
      "连接": "Connect",
      "超过": "Over",
      "默认": "Default",
      "清掉": "Clear",
      "固定": "Pin",
      "驳回": "Reject",
      "下架": "Retire",
      "最小": "Min",
      "代码": "Code",
      "不能进": "Blocked",
      "你选了": "You picked",
      "本对话": "This chat",
      "这里有": "Contains",
      "有帮助": "Helpful",
      "没帮助": "Not helpful",
      "登录名": "Login name",
      "上一个": "Previous",
      "下一个": "Next",
      "改密码": "Change password",
      "不限额": "No limit",
      "去登录": "Sign in",
      "换一个": "Switch",
      "服务商": "Provider",
      "每小时": "Hourly",
      "好评率": "Approval rate",
      "稳定性": "Stability",
      "积分数": "Credits",
      "原密码": "Current password",
      "模型名": "Model name",
      "专家团": "Expert team",
      "已安装": "Installed",
      "技能名": "Skill name",
      "装法：": "How to install:",
      "透明度": "Opacity",
      "还能用": "still works",
      "加进去": "Add it",
      "（无）": "(none)",
      "未授权": "Not granted",
      "未检测": "Not checked",
      "去授权": "Grant",
      "系统级": "System-wide",
      "运行中…": "Running…",
      "空文件。": "Empty file.",
      "加载失败": "Failed to load",
      "复制代码": "Copy code",
      "复制回复": "Copy reply",
      "重新生成": "Regenerate",
      "本次允许": "Allow once",
      "一直允许": "Always allow",
      "上传图片": "Upload image",
      "返回账号": "Back to account",
      "改登录名": "Change login name",
      "外观": "Appearance",
      "语言": "Language",
      "取消这条": "Cancel this",
      "当前密码": "Current password",
      "切换失败": "Switch failed",
      "退出登录": "Sign out",
      "修改密码": "Change password",
      "确认修改": "Confirm",
      "已配": "Set",
      "已连接：": "Connected:",
      "执行中…": "Running…",
      "我的项目": "My projects",
      "项目名称": "Project name",
      "选择模板": "Choose a template",
      "立即执行": "Run now",
      "批量启用": "Enable selected",
      "批量暂停": "Pause selected",
      "批量删除": "Delete selected",
      "每周某天": "Weekly",
      "每月某日": "Monthly",
      "没写理由": "No reason given",
      "打开对话": "Open chat",
      "被测模型": "Model under test",
      "每题次数": "Runs per item",
      "开始评测": "Start eval",
      "机器判分": "Auto-scored",
      "搜索项目": "Search projects",
      "收起 ✕": "Collapse ✕",
      "我的文档": "My documents",
      "＋ 上传": "＋ Upload",
      "精选场景": "Featured scenarios",
      "整团召唤": "Summon team",
      "立即召唤": "Summon now",
      "能力标签": "Capability tags",
      "绑定技能": "Attached skills",
      "团队名称": "Team name",
      "重新下载": "Re-download",
      "我的技能": "My skills",
      "立即使用": "Use now",
      "已装插件": "Installed plugins",
      "搜索资料": "Search library",
      "远程 ·": "Remote ·",
      "本地 ·": "Local ·",
      "插件提供": "From plugin",
      "保存模型": "Save model",
      "保存渠道": "Save channel",
      "＋ 添加渠道": "＋ Add channel",
      "自己填…": "Type it myself…",
      "（先加一个渠道）": "(add a channel first)",
      "添加": "Add",
      "只读": "Read-only",
      "记忆": "Memory",
      "关掉": "Turn off",
      "铺满看": "Fit to window",
      "下载到本地看": "Download to view",
      "去下载页": "Open downloads page",
      "正在看有没有新版…": "Checking for updates…",
      "正在读这份说明书…": "Reading this guide…",
      "我自己写一句 →": "Write my own →",
      "打开凭证页": "Open credentials page",
      "在浏览器里打开": "Open in browser",
      "测试搜索": "Test search",
      "底层引擎": "Engine",
      "思考模式": "Thinking mode",
      "测试连接": "Test connection",
      "下一步：": "Next:",
      "保存身份": "Save identity",
      "内置小猫": "Built-in cat",
      "上传照片": "Upload photo",
      "删除照片": "Delete photo",
      "本机扫到": "Found locally",
      "扫描中…": "Scanning…",
      "工作空间": "Workspace",
      "清理缓存": "Clear cache",
      "统计中…": "Counting…",
      "立即备份": "Back up now",
      "数据说明": "About your data",
      "正在数…": "Counting…",
      "清空全部": "Clear all",
      "保存全部": "Save all",
      "搜模板…": "Search templates…",
      "检测中…": "Checking…",
      "查看全部": "View all",
      "导出日志": "Export log",
      "清空记录": "Clear log",
      "无法检测": "Can't check",
      "读取中…": "Reading…",
      "统计最近": "Stats for last",
      "主题": "Theme",
      "皮肤": "Skin",
      "字号": "Font size",
      "密度": "Density",
      "字体": "Font",
      "运行方式": "How it runs",
      "清掉重复的": "Remove duplicates",
      "空工作表。": "Empty worksheet.",
      "本回合产出": "Produced this turn",
      "已达成 ✓": "Achieved ✓",
      "接着冲": "Keep going",
      "任务运行中": "Task running",
      "删除该任务": "Delete this task",
      "新的登录名": "New login name",
      "保存失败：": "Save failed:",
      "已接上": "Connected",
      "IM 通道": "IM channels",
      "去助理设置": "Assistant settings",
      "从模版创建": "Create from template",
      "搜索自动化": "Search automations",
      "加载明细…": "Loading details…",
      "一句话说明": "One-line description",
      "默认提示词": "Default prompt",
      "还没选成员": "No members yet",
      "与基线持平": "Same as baseline",
      "如 查得深": "e.g. digs deep",
      "已上传": "Uploaded",
      "添加连接器": "Add connector",
      "添加并连接": "Add & connect",
      "填进输入框": "Put in composer",
      "照着抄就行": "Just copy this",
      "不填也能用": "optional",
      "本机没找到": "Not found locally",
      "个性化偏好": "Preferences",
      "怎么拿凭证": "How to get credentials",
      "智能体设置": "Agent settings",
      "已授权": "Granted",
      "检测/授权": "Check / grant",
      "跑一轮复盘": "Run a review",
      "搜索快捷键": "Search shortcuts",
      "暂无成果文件": "No output files yet",
      "本地部署预览": "Local preview",
      "放开给手机看": "Share to phone",
      "在浏览器打开": "Open in browser",
      "预览": "Preview",
      "点击预览": "Click to preview",
      "点击用系统程序打开": "Click to open with the system app",
      "复制我的输入": "Copy my message",
      "清理失败": "Cleanup failed",
      "让我停下": "Stop me",
      "个人资料": "Profile",
      "检查更新": "Check for updates",
      "图片用不了：": "Image unusable:",
      "转图片失败：": "Image conversion failed:",
      "开启积分限额": "Enable credit limit",
      "状态读取失败": "Couldn't read status",
      "＋ 新建项目": "＋ New project",
      "设为基线": "Set as baseline",
      "最终回复摘录": "Final reply excerpt",
      "灵感笔记": "Idea notes",
      "＋ 创建专家": "＋ Create expert",
      "推荐技能": "Recommended skills",
      "＋ 添加技能": "＋ Add skill",
      "每格一次尝试": "One attempt per cell",
      "点评（可选）": "Comment (optional)",
      "如 调研专员": "e.g. Research analyst",
      "如 研究分析": "e.g. Research & analysis",
      "图像模型": "Image model",
      "视频模型": "Video model",
      "跟随模型默认": "Model default",
      "执行权限模式": "Permission mode",
      "最大执行步数": "Max steps",
      "自动续跑轮数": "Auto-continue rounds",
      "重新检测本机": "Rescan this machine",
      "桌面宠物": "Desktop pet",
      "默认没有宠物": "No pet by default",
      "显示桌面宠物": "Show desktop pet",
      "一只都没扫到": "None found",
      "保存背景说明": "Save background notes",
      "名称必填": "Name is required",
      "审计中心": "Audit center",
      "全部恢复默认": "Reset all to defaults",
      "点自动跑一轮": "Run a round",
      "新手引导": "Onboarding",
      "已本地部署": "Serving locally",
      "打不开所在位置": "Couldn't reveal location",
      "本会话一直允许": "Always allow in this session",
      "搜索对话内容…": "Search conversations…",
      "发起审批的任务": "Task requesting approval",
      "正在检查更新…": "Checking for updates…",
      "还没有用量记录": "No usage yet",
      "本地 · 用户": "Local · user",
      "没有匹配的项目": "No matching projects",
      "批量管理": "Bulk manage",
      "从模版添加": "Add from template",
      "＋ 添加自动化": "＋ Add automation",
      "用这个模版 →": "Use this template →",
      "每 30 分钟": "Every 30 min",
      "智能体评测": "Agent evals",
      "请输入项目名称": "Enter a project name",
      "质量维度": "Quality dimensions",
      "还没有参考资料": "No reference material yet",
      "还没有灵感笔记": "No idea notes yet",
      "用这个开始 →": "Start with this →",
      "＋ 创建专家团": "＋ Create expert team",
      "安装插件": "Install plugin",
      "如 汇报三件套": "e.g. Reporting trio",
      "＋ 添加连接器": "＋ Add connector",
      "没有匹配的模板": "No matching templates",
      "可执行文件路径": "Executable path",
      "选择文件夹": "Choose folder",
      "打开当前文件夹": "Open current folder",
      "权限档位": "Permission level",
      "数据安全": "Data security",
      "跟随全局默认": "Follow global default",
      "管理模型…": "Manage models…",
      "该项目还没有任务": "No tasks in this project yet",
      "办公": "Office",
      "工程": "Build",
      "工作线": "Work lane",
      "终端里的任务": "Task from the terminal",
      "（终端里起的任务）": "(started in the terminal)",
      "终端里（wb 命令行）": "In the terminal (wb)",
      "这条线上还没有任务": "No tasks in this lane yet",
      "该项目在这条线上还没有任务": "No tasks in this lane for this project",
      "做表、写稿、出图、发消息——鼠标流": "Docs, decks, images, messages — mouse work",
      "写代码、跑脚本、查日志——键盘流": "Code, scripts, logs — keyboard work",
      "本机的桌面办公 agent：专家团、技能库、记忆、生图生视频都在这条线上": "Your desktop office agent: expert teams, skills, memory, image and video generation all live here",
      "本机 OpenWorkBuddy 命令行（wb）那条线：终端里起的任务都归这儿，手机上点开就能接管、插话": "The OpenWorkBuddy CLI (wb) on this machine: tasks you start in a terminal show up here — open one on your phone to watch it and chime in",
      "正在跑——点开能看见它在干什么，也能插话": "Running — open it to see what it is doing, and chime in",
      "终端被关掉了，没跑完": "The terminal was closed before it finished",
      "刚跑完": "Just finished",
      "正在跑": "Running",
      "这条线还空着。在终端里跑": "Nothing here yet. Run",
      "，它就会出现在这儿——手机上也看得见。": "in a terminal and it shows up here — on your phone too.",
      "wb 你的活儿": "wb your task",
      "这趟是在终端里跑的。打字按 Enter 能插一句给它；想让它停，回终端按 Ctrl+C": "This one runs in your terminal. Type and press Enter to chime in; to stop it, press Ctrl+C there",
      "插一句给终端里的它（Enter）": "Chime in to the terminal run (Enter)",
      "送不到终端": "Could not reach the terminal",
      "项目名，回车创建": "Project name, Enter to create",
      "改名字 / 头像": "Rename / avatar",
      "自定义 cron": "Custom cron",
      "1 次 · 最快": "1 run · fastest",
      "5 次 · 严格": "5 runs · strict",
      "默认音色（可空）": "Default voice (optional)",
      "评测已开跑：": "Eval started:",
      "从角色模板起稿…": "Start from a role template…",
      "委派时点名用 ·": "Used when delegating ·",
      "这个团适合干什么": "What this team is for",
      "人工分已保存": "Manual score saved",
      "已接入的外部工具": "Connected external tools",
      "参数（空格分隔）": "Arguments (space-separated)",
      "单工具超时（秒）": "Per-tool timeout (s)",
      "助理的名字和头像": "Assistant name and avatar",
      "闲置自动开新会话": "Auto new session when idle",
      "批量删除审批阈值": "Bulk-delete approval threshold",
      "秒（超时按拒绝）": "s (timeout = deny)",
      "内置运行时": "Built-in runtime",
      "没有匹配的快捷键": "No matching shortcuts",
      "采纳，写进提示词": "Accept, add to prompt",
      "重新打开新手引导": "Reopen onboarding",
      "已并入当前任务": "Merged into current task",
      "选择新文件夹…": "Choose new folder…",
      "点一下就切换界面语言，AI 回复也跟着换": "One click switches the UI language; AI replies follow",
      "云端 API": "Cloud API",
      "打开所在文件夹": "Open containing folder",
      "用这个模版新建 →": "New from this template →",
      "还没有可挂载的条目": "Nothing to attach yet",
      "3 次 · 测稳定": "3 runs · stability",
      "不用（只机器判分）": "None (auto-score only)",
      "请填写任务描述": "Enter a task description",
      "请完成时间设置": "Finish the schedule settings",
      "行业调研，信息核实": "Industry research, fact-checking",
      "OpenAI 兼容": "OpenAI-compatible",
      "＋ 添加自定义模型": "＋ Add custom model",
      "模型卡壳超时（秒）": "Model stall timeout (s)",
      "走 API Key": "Use API key",
      "数据备份与恢复": "Backup & restore",
      "快速上手：输入框里": "Quick start: in the composer,",
      "引用工作空间文件、": "to reference workspace files,",
      "点击后按下新组合键": "Click, then press the new combo",
      "本地预览服务启动失败": "Local preview server failed to start",
      "移除项目（不删文件）": "Remove project (keeps files)",
      "加载失败（未登录？）": "Failed to load (not signed in?)",
      "允许别人自己注册账号": "Allow self-registration",
      "工作日（周一到周五）": "Weekdays (Mon–Fri)",
      "粘贴 API Key": "Paste API key",
      "项目名称不能为空": "Project name can't be empty",
      "本地产物（当前项目）": "Local outputs (this project)",
      "左边挑一个文件看内容": "Pick a file on the left to view it",
      "保存即生效，不用重启": "Takes effect on save, no restart",
      "有零件被跳过：": "Some parts were skipped:",
      "专家已保存，立即生效": "Expert saved, effective now",
      "技能已保存，立即生效": "Skill saved, effective now",
      "视觉模型（看图）": "Vision model (images)",
      "正在看本机装了哪些…": "Checking what's installed…",
      "上下文预算（千字符）": "Context budget (k chars)",
      "正在找本机装了哪些…": "Looking for local installs…",
      "不含工作空间成果文件": "Excludes workspace output files",
      "清空 IM 会话记忆": "Clear IM session memory",
      "点一下展开 / 收起": "Click to expand / collapse",
      "名称和模型名必填": "Name and model name are required",
      "它自己怎么变好的": "How it improves itself",
      "提案永远不会自动生效": "Proposals never apply automatically",
      "停下当前任务（Esc）": "Stop current task (Esc)",
      "带着写好的项目指令开工": "Start with the project instructions",
      "会真实调用所选模型计费": "Calls the selected model for real (billed)",
      "新密码（至少 6 位）": "New password (6+ characters)",
      "任务名（如：每日晨报）": "Task name (e.g. Daily briefing)",
      "配好了，开始干活吧": "All set, let's get to work",
      "先勾选要操作的任务": "Select tasks first",
      "工作目录还没有成果文件": "No output files in the working folder yet",
      "专家团已保存，立即生效": "Team saved, effective now",
      "本地命令（stdio）": "Local command (stdio)",
      "远程连接器要填地址": "Remote connectors need a URL",
      "本地连接器要填命令": "Local connectors need a command",
      "沙箱安全 · 文件": "Sandbox · Files",
      "沙箱安全 · 网络": "Sandbox · Network",
      "沙箱安全 · 命令": "Sandbox · Commands",
      "和左栏会跟着一起缩放。": "and the sidebar scale with it.",
      "记下了，会进下一轮复盘。": "Noted, it goes into the next review.",
      "手机同 Wi-Fi 可开": "Phones on the same Wi-Fi can open it",
      "都不是？直接说你想要的…": "None of these? Just tell me what you want…",
      "检查更新失败：接口无响应": "Update check failed: no response",
      "（每次跑批自动逐题对比）": "(each batch compares item by item)",
      "这个插件没带任何可用组件": "This plugin ships no usable components",
      "语音合成（TTS）": "Speech synthesis (TTS)",
      "任务最大运行时间（分钟）": "Max task runtime (min)",
      "关闭（默认，不自动换道）": "Off (default, no auto failover)",
      "检测失败：拿不到引擎列表": "Check failed: couldn't get engine list",
      "目录，不上传任何服务器。": "folder, never uploaded anywhere.",
      "用飞书 App 扫这个码": "Scan this with the Feishu app",
      "检测 lark-cli…": "Checking lark-cli…",
      "名称（如：我的vLLM）": "Name (e.g. My vLLM)",
      "本次运行期间记住的批准：": "Approvals remembered this run:",
      "登录时输的那个名字，现在是": "The name you sign in with, currently",
      "还没有连接任何 IM 通道": "No IM channels connected yet",
      "协调者据此决定什么活派给它": "The coordinator uses this to decide what to delegate",
      "逗号分隔，只用于展示和搜索": "Comma-separated, for display and search only",
      "从当初安装的地址重新拉一遍": "Re-fetch from the original install URL",
      "导出全部记忆（.md）": "Export all memory (.md)",
      "天 · 会调一次模型，花钱": "days · calls the model once, costs money",
      "这一行就是聊天正文的大小，": "This line is the chat text size;",
      "收到，做完这一步就看这句": "Got it, I'll read this after this step",
      "这个文档里没有可显示的正文。": "Nothing displayable in this document.",
      "工作目录（成果文件都放这儿）": "Working folder (outputs go here)",
      "切换模版会覆盖当前编辑的指令": "Switching template overwrites the current instructions",
      "表太长，只显示前 500 行": "Table too long, showing first 500 rows",
      "从 GitHub 安装": "Install from GitHub",
      "擅长什么、什么时候该委派给它": "What it's good at, when to delegate to it",
      "这条给这台机器上所有账号共用": "Shared by every account on this machine",
      "系统授权（macOS）": "System permissions (macOS)",
      "已清掉本次运行期间记住的批准": "Cleared approvals remembered this run",
      "收到，做完这一步就看你这句": "Got it, I'll read your note after this step",
      "语音录制暂未支持（复刻版）": "Voice recording not supported yet",
      "近 7 天消耗（tokens）": "Last 7 days usage (tokens)",
      "拿不到配置体检表，服务没起来？": "Couldn't load the config check. Is the server up?",
      "点一下带着写好的提示词开新任务": "Click to start a new task with this prompt",
      "创建属于你的专家，分享专业知识": "Create your own expert with domain knowledge",
      "还没有技能，去「技能」页装一个": "No skills yet. Install one on the Skills page",
      "随手记一条灵感/偏好，回车保存": "Jot down an idea or preference, Enter to save",
      "个工具已注入，任务里可直接调用": "tools injected, callable in tasks",
      "备用渠道（主模型挂起自动换道）": "Fallback (auto switch when primary fails)",
      "保存路径 / 模型 / 思考档": "Save path / model / thinking level",
      "要问你问题时跳起来并弹系统通知": "Bounce and notify when it has a question",
      "太久没聊，下一条不再带旧上下文": "After a long idle, the next message drops old context",
      "哪儿不对？一句话就行（可以不写）": "What went wrong? One line is enough (optional)",
      "已设为基线，之后每轮自动对比": "Set as baseline, every round compares against it",
      "要提问时弹系统通知 + 图标跳动": "Notify + bounce the icon when it asks",
      "任务干完 / 出错时也提醒我一声": "Also notify me when a task finishes or fails",
      "记得手动重启应用，恢复才完全生效": "Restart the app manually to finish restoring",
      "驳回理由（会喂回给模型当负样本）": "Reason for rejecting (fed back as a negative example)",
      "切换 Craft 按此计划执行": "Switch to Craft and run this plan",
      "想同时做别的，点左上「新建任务」。": "To work on something else at the same time, click \"New task\" top left.",
      "界面上显示的名字，留空就用登录名。": "Display name; leave empty to use the login name.",
      "文字存盘失败，已按普通粘贴处理": "Couldn't save text, pasted as plain text",
      "说明（协调者据此决定什么活整团派）": "Description (the coordinator uses it to decide when to send the whole team)",
      "手写一份操作说明书，智能体按需加载": "Write a playbook by hand; the agent loads it on demand",
      "还没扫码。点右上角「连接」取二维码": "Not scanned yet. Click \"Connect\" top right for the QR code",
      "复制失败，手动选中上面的文字吧": "Copy failed, select the text above manually",
      "这些只存在这台电脑上，不跟账号走。": "These live only on this computer, not with your account.",
      "改它的模型 / 换回内置引擎…": "Change its model / back to built-in engine…",
      "归档目标（不再显示，也不再按它验收）": "Archive goal (hidden, no longer checked against)",
      "下面挑一个，或者打几个字、上传一张图": "One or two emoji, or upload an image",
      "cron 表达式：分 时 日 月 周": "cron expression: min hour day month weekday",
      "文件太大，预览不动，请下载后本地打开": "File too large to preview. Download and open locally",
      "即可，装一次技能和 MCP 一起进来": "and one install brings skills and MCP together",
      "正在看这一档对当前模型是怎么生效的…": "Checking how this level applies to the current model…",
      "token 预算（万 tokens）": "Token budget (×10k tokens)",
      "闲着时让它在桌面上随便走走（默认关）": "Let it wander the desktop when idle (off by default)",
      "背景说明（全局共享，原样进提示词）": "Background notes (global, inserted into the prompt verbatim)",
      "Codex / Petdex 的像素宠物": "Codex / Petdex pixel pets",
      "模型名（如 deepseek-chat）": "Model name (e.g. deepseek-chat)",
      "技能＝写给智能体看的操作说明书，它按需加载": "A skill is a playbook written for the agent; it loads on demand",
      "一句话描述（AI 据此判断什么任务该用它）": "One-line description (the AI uses it to decide when to use this)",
      "远程地址（Streamable HTTP）": "Remote URL (Streamable HTTP)",
      "请求头（可选，每行 Key: Value）": "Headers (optional, one Key: Value per line)",
      "保存视觉 / 图像 / 视频 / 语音模型": "Save vision / image / video / speech models",
      "或把其它 agent 的记忆文本粘到这里…": "or paste another agent's memory text here…",
      "紧凑：消息间距和行高收一收，一屏多看三成。": "Compact: tighter spacing and line height, about 30% more per screen.",
      "还没接上大模型，随时在 设置 → 模型 里补": "No model connected yet. Add one any time in Settings → Models",
      "这条是插件声明的，要去「插件」页卸载整个插件": "Declared by a plugin. Uninstall the whole plugin on the Plugins page",
      "这台机器没找到局域网地址（没连 Wi-Fi？）": "No LAN address found (not on Wi-Fi?)",
      "用户反馈 · 近 30 天在对话里点的": "User feedback · last 30 days in chats",
      "记住的事（AI 自己记的 + 你手动加的）": "Remembered (by the AI + added by you)",
      "模型名（如 tts-1 / qwen-tts）": "Model name (e.g. tts-1 / qwen-tts)",
      "本机 skills/ 目录里的，加上插件带进来的": "From the local skills/ folder plus those brought by plugins",
      "正文（Markdown：步骤、代码示例、注意事项）": "Body (Markdown: steps, code samples, caveats)",
      "记忆搬家（导出 / 从其它 agent 导入）": "Move memory (export / import from another agent)",
      "复用此条的接口地址和 Key，换个模型名即成新模型": "Reuse this entry's URL and key with a different model name",
      "默认音色（如 alloy / Cherry，可空）": "Default voice (e.g. alloy / Cherry, optional)",
      "个文件跟成果文件夹里的完全相同（同一份东西显示两遍）": "files are identical to the output folder (shown twice)",
      "Authorization: Bearer 你的令牌": "Authorization: Bearer your-token",
      "例如：所有文档默认用简体中文；数据分析结论放最前面…": "e.g. Write all documents in English; put analysis conclusions first…",
      "这段时间没数出毛病来——要么真没出错，要么样本太少。": "Nothing counted as a failure in this window: either nothing broke, or the sample is too small.",
      "单个任务 Agent 循环上限，防止失控（默认 25）": "Agent loop cap per task, to stop runaways (default 25)",
      "同一个 Wi-Fi 下的人都能翻你的工作目录，看完记得停": "Anyone on the same Wi-Fi can browse your working folder. Stop it when done",
      "要自动执行的任务描述，如：抓取今天的 AI 新闻生成晨报": "What to run, e.g. Fetch today's AI news and write a morning brief",
      "当前是纯服务端模式（npm start），宠物只在桌面版": "Server-only mode (npm start); the pet only exists in the desktop app",
      "用你电脑上这个 CLI 的登录态和它自己的模型跑，所以下面那排 API 模型这会儿一个都用不上。": "Runs on this local CLI's own login and model, so none of the API models below are used right now.",
      "用它自己的默认模型": "its own default model",
      "这个对话用哪个模型（点开可以只给本对话换一个）": "Which model this chat uses (open to switch just this chat)",
      "历史成绩 · 点一行看每题明细 / 打人工分 / 设为基线": "History · click a row for per-item details / manual scores / set baseline",
      "跳过了。随时可以在 设置 → 模型 里补上 API Key": "Skipped. Add an API key any time in Settings → Models",
      "干活前会提示它先加载这些技能包，别全勾——勾多了等于没重点": "It's told to load these skills before working. Don't tick everything; too many means no focus",
      "没有待审的提案。点上面「跑一轮复盘」让它看看最近摔在哪儿。": "No proposals pending. Click \"Run a review\" above to have it look at recent failures.",
      "还没有生效的规则。规则来自被你采纳的提案，不会自己长出来。": "No active rules. Rules come from proposals you accept; they don't grow on their own.",
      "还没有记录。AI 执行命令 / 联网访问时会自动记录在这里。": "No records yet. Commands and network access by the AI are logged here.",
      "该任务还没有保存的对话记录（可能创建于旧版本），继续对话即可。": "No saved conversation for this task (maybe from an older version). Just keep chatting.",
      "emoji 或者一张图都行，图会自动裁成方的压到 128px。": "An emoji or an image; images are cropped square and shrunk to 128px.",
      "一支按顺序接力的智能体团队：后一位能看到前一位的汇报和产出文件": "A relay team of agents: each one sees the previous one's report and files",
      "新对话自动沿用上次手动选过的模型（不勾则新对话总是用全局默认）": "New chats reuse the last manually chosen model (unticked: always the global default)",
      "模型名（如 qwen-image / gpt-image-1）": "Model name (e.g. qwen-image / gpt-image-1)",
      "手动加一条，例如：周报只要三段——进展 / 问题 / 下周计划": "Add one by hand, e.g. Weekly reports need three parts: progress / issues / next week",
      "每个项目一个独立工作目录，自带指令与专属配置，任务历史按项目分组": "Each project has its own folder, instructions and settings; task history is grouped by project",
      "例如：我们公司是做跨境电商的，主营美妆品类；周报收件人是运营部…": "e.g. We're a cross-border e-commerce company focused on beauty; weekly reports go to Ops…",
      "还没有对话。直接在下方输入框发条消息，或在飞书/微信里 @机器人。": "No conversations yet. Send a message below, or @ the bot in Feishu/WeChat.",
      "接口地址（如 https://api.openai.com/v1）": "API URL (e.g. https://api.openai.com/v1)",
      "助理页发消息用哪个模型（飞书 / QQ 等远程消息仍按全局默认跑）": "Model for the assistant page (Feishu / QQ remote messages still use the global default)",
      "成员与顺序（至少 2 位；点击加入，再点移除。列表顺序＝执行顺序）": "Members and order (at least 2; click to add, click again to remove. List order = run order)",
      "整个任务（含专家子代理）的墙上时间预算，超时强制收尾（默认 10）": "Wall-clock budget for the whole task incl. sub-agents; forced wrap-up on timeout (default 10)",
      "Agent 读写文件与成果输出的文件夹（输入框下方也可快速切换）。": "Folder the agent reads, writes and outputs to (also switchable below the composer).",
      "飞书 · 微信 · QQ · 企业微信 · 钉钉 · Webhook": "Feishu · WeChat · QQ · WeCom · DingTalk · Webhook",
      "还没有自动化任务。点右上角「＋ 添加自动化」或「从模版添加」建一个。": "No automations yet. Click \"＋ Add automation\" or \"Add from template\" top right.",
      "真正喂给这个智能体的角色设定：角色一句话 + 工作方式清单 + 红线": "The role prompt this agent actually gets: one-line role + working style + hard limits",
      "（每题重复 k 次：pass@1 均值看能不能，k 次全过看稳不稳）、": "(each item repeated k times: mean pass@1 for ability, all-k-pass for stability),",
      "（那些你自己看得见）。恢复会先自动备份当前现状，恢复后需重启应用生效。": "(the ones you can see). Restoring backs up the current state first; restart the app afterwards.",
      "（默认关，因为每次都要调一次模型花钱；跑出来的提案仍然要你点头才生效）": "(off by default since each run calls the model and costs money; proposals still need your approval)",
      "还没有运行记录。任务跑过之后（定时触发或手动执行）这里会留下每一次的流水。": "No runs yet. Every scheduled or manual run leaves a record here.",
      "还没钉基线——点开一次成绩，点「": "No baseline pinned. Open a result and click \"",
      "设为基线」，之后每轮自动对比退步/进步": "Set as baseline\"; later rounds compare against it",
      "还没有。你说「以后都这样」「记住…」时它会自己记一条；也可以在下面手动加。": "Nothing yet. When you say \"always do this\" or \"remember…\" it notes it; you can also add one below.",
      "我正忙着这件事。想补一句或改方向？在下面打字、按 Enter，我做完这一步就看。": "I'm busy with this. Want to add something or change direction? Type below and press Enter; I'll read it after this step.",
      "Markdown 直接排版 ·": "Markdown rendered ·",
      "CSV 变表格 ·": "CSV as tables ·",
      "HTML 真渲染": "HTML live",
      "这是个网页，要不要本地部署预览？（起一个本机服务，相对路径和 fetch 才正常）": "This is a web page. Serve it locally? (relative paths and fetch only work with a local server)",
      "适合放团队/业务背景、常用数据口径、固定模板要求这种成段的东西。所有账号共用一份。": "For team/business background, data definitions and template rules. Shared by all accounts.",
      "点卡片看全文；带 __下划线__ 的地方换成你的内容；「填进输入框」直接开一条新任务": "Click a card for the full text; replace the __underlined__ parts; \"Put in composer\" starts a new task",
      "任务里 AI 也能读这里的资料（library_list / library_read）": "The AI can read this material in tasks (library_list / library_read)",
      "走本机 CLI 不需要 API Key，用的是它自己的登录；我会真发一句话过去确认它能答。": "The local CLI needs no API key, it uses its own login; I'll send a real message to confirm it answers.",
      "本地进程走 stdio；托管在别人服务器上的走 Streamable HTTP，填地址就行": "Local processes use stdio; hosted ones use Streamable HTTP, just enter the URL",
      "给它起个自己顺口的名字。名字会同时改掉界面标题、侧栏和系统提示词——你喊它这个名字它就认。": "Give it a name you like. It changes the title, sidebar and system prompt; call it by that name and it answers.",
      "接口地址（如 https://dashscope.aliyuncs.com/api/v1）": "API URL (e.g. https://dashscope.aliyuncs.com/api/v1)",
      "重复跑才能看出稳定性：pass@1 均值看「能不能」，k 次全过看「稳不稳」。费用按次数翻倍": "Repeats reveal stability: mean pass@1 for ability, all-k-pass for consistency. Cost scales with runs",
      "整仓库 / tree 子目录 / blob 单文件 / raw 直链都行，装完立即生效不用重启": "Whole repo / tree subfolder / blob file / raw link all work; effective immediately, no restart",
      "按次数排。只有标「提示词能治」的才允许变成规则——改代码/换渠道的毛病，加多少句提示词都没用。": "Sorted by count. Only those marked \"fixable by prompt\" can become rules; code or provider problems don't respond to prompts.",
      "给 look_at_image 工具用：你粘贴（⌘V）或拖进来的截图，它带着问题去看，拿回文字。": "For the look_at_image tool: screenshots you paste (⌘V) or drop are viewed with a question, and text comes back.",
      "其他助理通道：钉钉机器人双向 / Telegram / Slack 都走「通用 Webhook」桥接": "Other channels: DingTalk bot / Telegram / Slack go through the generic Webhook bridge",
      "输入框下方「权限」下拉可随时切换：Ask 只问答 · Plan 只出计划 · Craft 完整执行交付": "Switch any time in the permission dropdown below the composer: Ask answers only · Plan plans only · Craft executes and delivers",
      "模型名（如 gpt-5-mini / z-ai/glm-5.3-flash / qwen-vl-max）": "Model name (e.g. gpt-5-mini / z-ai/glm-5.3-flash / qwen-vl-max)",
      "当前是 Web 模式：授权对象是启动本服务的终端；「辅助功能」状态仅桌面版（npm run app）能查询。": "Web mode: permissions apply to the terminal that started the server; Accessibility status is only readable in the desktop app (npm run app).",
      "模型名（如 wan2.2-t2v-plus / doubao-seedance-1-0-pro-250528）": "Model name (e.g. wan2.2-t2v-plus / doubao-seedance-1-0-pro-250528)",
      "提供当前项目的背景信息和规范，让 AI 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等": "Background and conventions for this project so replies fit better: goals, team habits, style, output constraints",
      "传输加密：前后端走本机回环地址通信不经公网；对外仅按你配置的通道（飞书/企微/钉钉官方 HTTPS API）传输。": "Transport: frontend and backend talk over loopback, never the public internet; outbound only through the channels you configure (official Feishu/WeCom/DingTalk HTTPS APIs).",
      "调用技能；侧栏「技能库 / 专家团 / 定时任务」都支持增删改热生效；手机远程用 设置→助理设置 绑定飞书或企业微信。": "to call skills; Skills / Experts / Schedules in the sidebar hot-reload on edit; for remote use bind Feishu or WeCom in Settings → Assistant.",
      // 引导 / 语言开关
      "大模型": "Model",
      "联网搜索": "Web search",
      "图/视频/语音": "Image / video / voice",
      "远程指挥": "Remote control",
      "完成": "Done",
      "下一步": "Next",
      "验活并继续": "Verify and continue",
      "先跳过": "Skip for now",
      "界面语言": "Interface language",
      "AI 回复也会跟着用这个语言": "AI replies follow this language too",
      "设置 → 外观 里随时能改": "Change any time in Settings → Appearance",
      // 连接器预设目录
      "推荐连接器": "Recommended connectors",
      "点「接入」我会把启动命令填好，要 Key 的填上就能连；都是官方或社区现成的 MCP 服务器": "Click \"Connect\" and I fill in the launch command; add the key if one is needed. All are official or community MCP servers",
      "本机没找到 uvx：标着 uvx 的连接器要先装 uv（macOS 装法：brew install uv）": "uvx not found on this machine: connectors marked uvx need uv first (macOS: brew install uv)",
      "本机没找到 npx：先装 Node.js（自带 npx）再来接本地连接器": "npx not found on this machine: install Node.js (ships npx) before adding local connectors",
      "接入": "Connect",
      "已接入": "Added",
      "免 Key": "No key needed",
      "远程": "Remote",
      "去哪拿 →": "Where to get it →",
      "去哪拿 Key →": "Where to get the key →",
      "环境变量": "Environment variables",
      "API Key 之类放这里，每行一个 KEY=值，不需要就空着": "API keys go here, one KEY=value per line; leave empty if not needed",
      "BRAVE_API_KEY=你的 Key": "BRAVE_API_KEY=your key",
      "启动命令已填好，点「添加并连接」就能用": "Launch command filled in. Click \"Add & connect\" to use it",
      "还没有连接器，从下面的推荐里挑一个点「接入」": "No connectors yet. Pick one below and click \"Connect\"",
      "环境变量要写成 KEY=值": "Environment variables must be KEY=value",
    },
  };

  // 带数字/名字的动态句子：整句匹配，$1 回填
  const PATTERNS = {
    en: [
      [/^第 (\d+) 步 · 思考规划中…$/, "Step $1 · thinking…"],
      [/^第 (\d+) 步$/, "Step $1"],
      [/^· 产出 (\d+) 件$/, "· $1 outputs"],
      [/^还有 (\d+) 个文件$/, "$1 more file(s)"],
      [/^全部 (\d+)$/, "All $1"],
      [/^只看成果 (\d+)$/, "Results only $1"],
      [/^(\d+) 份成果$/, "$1 result(s)"],
      [/^已折起 (\d+) 个中间材料（脚本 \/ 数据 \/ 日志）$/, "$1 working files folded (scripts / data / logs)"],
      [/^这个工作目录里还没有成果文件（(\d+) 个中间材料已折起）$/, "No result files in this folder yet ($1 working files folded)"],
      [/^· 续跑 (\d+) 轮$/, "· continued $1 rounds"],
      [/^· 缓存命中 (\d+)%$/, "· cache hit $1%"],
      [/^· (\d+) 积分$/, "· $1 credits"],
      [/^来自插件 (.+)$/, "From plugin $1"],
      [/^没找到 (.+)$/, "$1 not found"],
      [/^要填 (\d+) 个 Key$/, "$1 key(s) to fill"],
      [/^（带 (\d+) 个环境变量：(.+)）$/, "($1 env vars: $2)"],
      [/^还差 (.+) 没填$/, "Still missing: $1"],
      [/^还差 (.+) 没填，填好点「添加并连接」$/, "Still missing $1. Fill it in, then click \"Add & connect\""],
      [/^来自「(.+)」$/, "From \"$1\""],
      [/^编辑「(.+)」$/, "Edit \"$1\""],
      [/^编辑项目「(.+)」$/, "Edit project \"$1\""],
      [/^编辑技能「(.+)」$/, "Edit skill \"$1\""],
      [/^编辑专家「(.+)」$/, "Edit expert \"$1\""],
      [/^编辑专家团「(.+)」$/, "Edit team \"$1\""],
      [/^确认删除「(.+)」？$/, "Delete \"$1\"?"],
      [/^已装 (\d+)$/, "$1 installed"],
      [/^运行中 (\d+)$/, "Running $1"],
      [/^启用中（(\d+)）$/, "Enabled ($1)"],
      [/^已暂停（(\d+)）$/, "Paused ($1)"],
      [/^共 (\d+) 页$/, "$1 pages"],
      [/^共 (\d+) 个$/, "$1 total"],
      [/^…共 (\d+) 个$/, "… $1 total"],
      [/^一键装齐缺的 (\d+) 个$/, "Install the $1 missing"],
      [/^用时 (.+)$/, "Took $1"],
      [/^请求失败（HTTP (\d+)）$/, "Request failed (HTTP $1)"],
      [/^(\d+) 个工具已注入，任务里可直接调用$/, "$1 tools injected, callable in tasks"],
      [/^近 (\d+) 天$/, "Last $1 days"],
      [/^第 (\d+) 页$/, "Page $1"],
      [/^跑脚本 (\d+) 行 Node$/, "Run $1 lines of Node"],
      // 引擎小牌子：服务端推来的是「本机 Claude Code 已启动（模型 x，N 个工具），不消耗 API 额度」。
      // 界面拆成了「名字 / 括号里那截 / 不花 API 额度」三块分别显示，所以这里连整条带那一截都得能翻，
      // 不然英文界面上会孤零零挂一行中文。整条那两条是给鼠标悬停的 title 用的
      [/^模型 默认$/, "default model"],
      [/^模型 (.+?)，(\d+) 个工具$/, "model $1, $2 tools"],
      [/^模型 (.+)$/, "model $1"],
      [/^本机 Claude Code 已启动（模型 (.+?)，(\d+) 个工具），不消耗 API 额度$/, "Local Claude Code started (model $1, $2 tools) — no API quota used"],
      [/^本机 Codex 已启动（模型 (.+?)），不消耗 API 额度$/, "Local Codex started (model $1) — no API quota used"],
      // 冷启动那几秒的占位牌子，同样拆成三块显示，所以括号里那截也得单独能翻
      [/^连接工具中，一般 3~8 秒$/, "connecting tools, usually 3-8s"],
      [/^本机 Claude Code 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度$/, "Local Claude Code is starting (connecting tools, usually 3-8s) — no API quota used"],
      [/^本机 Codex 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度$/, "Local Codex is starting (connecting tools, usually 3-8s) — no API quota used"],
    ],
  };

  // ---------- 过程区那一行「动词 + 对象」 ----------
  // 服务端把每一步算成「读 报告.md」「搜「小红书 标题」」这种一行流（agent.js 的 toolHeadline）。
  // 对象是路径 / 关键词 / 命令，语言无关；动词是中文——英文界面下这一屏以前整片是中文。
  // 这里只把打头的动词翻掉，对象一个字不动。轨迹条上的短标（TOOL_SHORT）也一并翻。
  // ⚠️ 改了 agent.js 的 TOOL_VERB 或 app-01.js 的 TOOL_SHORT，记得同步这张表（test/e2e.js 有闸门盯着）。
  const TOOL_VERB_EN = {
    "读资料": "Read doc", "读": "Read", "写": "Write", "改": "Edit", "列目录": "List",
    "搜文件": "Find", "搜": "Search", "命令": "Shell", "跑脚本": "Run", "抓": "Fetch",
    "渲染": "Render", "体检": "Check", "截图": "Screenshot", "看图": "View",
    "生图": "Image", "生成视频": "Video", "画图表": "Chart", "配音": "Voice",
    "记住": "Remember", "忘掉": "Forget", "翻资料库": "Library", "存技能": "Save skill",
    "用技能": "Use skill", "桌面宠物": "Desktop pet", "问你一句": "Ask you",
    "飞书文档": "Feishu doc", "委派专家团": "Delegate to team", "委派专家": "Delegate to",
  };
  // 轨迹条（折叠条上那排小徽章）用的是另一套更短的标，见 app-01.js 的 TOOL_SHORT
  // 短标现在只剩字，图标是 sprite 里另一张表（app-01.js 的 TOOL_ICON）。
  // 以前这儿的键长这样："📄 读" —— 表情跟着一起进翻译表，加个工具要在两处各抄一遍图。
  const TOOL_SHORT_EN = {
    "读": "Read", "写": "Write", "改": "Edit", "列": "List",
    "找": "Find", "命令": "Shell", "搜": "Search",
    "抓": "Fetch", "渲染": "Render", "查页": "Check", "截图": "Shot",
    "看图": "View", "生图": "Image", "视频": "Video", "图表": "Chart",
    "配音": "Voice", "记": "Save", "忘": "Forget", "库": "Library",
    "读库": "Read lib", "存技能": "Save skill", "宠物": "Pet",
  };
  for (const [zh, en] of Object.entries(TOOL_SHORT_EN)) if (!(zh in DICT.en)) DICT.en[zh] = en;
  for (const [zh, en] of Object.entries(TOOL_VERB_EN)) {
    const q = zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    PATTERNS.en.push([new RegExp("^" + q + "「(.+?)」(.*)$"), en + ' "$1"$2']);
    PATTERNS.en.push([new RegExp("^" + q + "( .*)?$"), en + "$1"]);
  }

  // 界面上开头那些表情（❌ ⚠️ ✅ 🪪 ⚙️ 🌐 …）正在一处处换成 SVG 图标。图标是 <svg>，
  // 翻译器不碰 SVG，所以换完之后 DOM 里的文本节点变成了光秃秃的「个人资料」，
  // 而词条当年是按「🪪 个人资料」收的——对不上就漏翻，页面会中英混着显示。
  // 这里给每条带前缀表情的词自动补一条不带表情的别名：两种写法都认，
  // 于是「这一处换没换图标」和「翻译掉不掉」彻底解耦，换到哪算哪，不用回头改词条。
  const LEAD_MARK = /^(?:[\u2190-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]+[\uFE0F\u200D]*\s*)+/u;
  const unmark = (s) => String(s).replace(LEAD_MARK, "");
  for (const [zh, en] of Object.entries({ ...DICT.en })) {
    const bare = unmark(zh);
    if (bare && bare !== zh && !(bare in DICT.en)) DICT.en[bare] = unmark(en);
  }
  for (const [re, out] of [...PATTERNS.en]) {
    const m = /^\^(?:[\u2190-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]+[\uFE0F\u200D]*\s*)+/u.exec(re.source);
    if (m) PATTERNS.en.push([new RegExp("^" + re.source.slice(m[0].length)), unmark(out)]);
  }

  // ---------- 语言读写 ----------
  const mem = {};
  function read(k) {
    try {
      const v = root && root.localStorage ? root.localStorage.getItem(k) : null;
      if (v != null) return v;
    } catch {}
    return mem[k];
  }
  function write(k, v) {
    mem[k] = v;
    try { if (root && root.localStorage) root.localStorage.setItem(k, v); } catch {}
  }
  function detect() {
    const n = String((root && root.navigator && root.navigator.language) || "");
    if (!n) return "zh";
    return /^zh/i.test(n) ? "zh" : "en";
  }
  function getLang() {
    const v = read(STORE_KEY);
    return LANGS[v] ? v : detect();
  }

  // ---------- 查词 ----------
  function lookup(text, lang) {
    if (lang === "zh" || !text) return null;
    const d = DICT[lang];
    if (!d) return null;
    if (Object.prototype.hasOwnProperty.call(d, text)) return d[text];
    for (const [re, out] of PATTERNS[lang] || []) {
      const m = re.exec(text);
      if (m) return out.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? "");
    }
    return null;
  }
  function t(zh, params) {
    let s = lookup(zh, getLang());
    if (s == null) s = zh;
    if (params) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    return s;
  }
  // 保留首尾空白（模板里 "<b>x</b> 保存" 这种文本节点带前导空格）
  function tr(text, lang = getLang()) {
    if (text == null) return text;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(text));
    if (!m[2]) return text;
    const out = lookup(m[2], lang);
    return out == null ? text : m[1] + out + m[3];
  }

  // ---------- DOM ----------
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "PRE", "CODE", "KBD", "SVG", "NOSCRIPT"]);
  // 输入框：placeholder 是界面要翻，里面的字是用户打的不能碰——只翻属性、不进子树
  const ATTR_ONLY_TAGS = new Set(["TEXTAREA", "INPUT"]);
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const tag = (el) => String(el.nodeName).toUpperCase();
  function skipEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(tag(el))) return true;
    if (typeof el.getAttribute !== "function") return false;
    return el.getAttribute("translate") === "no" || el.hasAttribute("data-i18n-skip");
  }
  function inSkipped(node) {
    for (let e = node && node.parentNode; e && e.nodeType === 1; e = e.parentNode) if (skipEl(e) || ATTR_ONLY_TAGS.has(tag(e))) return true;
    return false;
  }
  // 文本节点：记住源文 __src 和我们写进去的译文 __out。
  //   当前值 == __out → 是我们翻的，没被应用改过；切中文就还原。
  //   否则当前值就是新的源文（应用刚写进去的中文）。
  function trText(node, lang) {
    const cur = node.nodeValue;
    if (cur == null || !cur.trim()) return;
    const mine = node.__i18nOut !== undefined && cur === node.__i18nOut;
    const src = mine ? node.__i18nSrc : cur;
    if (lang === "zh") {
      if (mine) node.nodeValue = src;
      node.__i18nOut = undefined;
      return;
    }
    const out = tr(src, lang);
    if (out === src) { if (mine) { node.nodeValue = src; } node.__i18nOut = undefined; return; }
    node.__i18nSrc = src;
    node.__i18nOut = out;
    if (cur !== out) node.nodeValue = out;
  }
  function trAttr(el, name, lang) {
    if (typeof el.getAttribute !== "function" || !el.hasAttribute(name)) return;
    const cur = el.getAttribute(name);
    const store = el.__i18nAttr || (el.__i18nAttr = {});
    const rec = store[name];
    const mine = rec && cur === rec.out;
    const src = mine ? rec.src : cur;
    if (lang === "zh") {
      if (mine) el.setAttribute(name, src);
      delete store[name];
      return;
    }
    const out = tr(src, lang);
    if (out === src) { if (mine) el.setAttribute(name, src); delete store[name]; return; }
    store[name] = { src, out };
    if (cur !== out) el.setAttribute(name, out);
  }
  function walk(node, lang) {
    if (!node) return;
    if (node.nodeType === 3) { trText(node, lang); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (skipEl(node)) return;
      for (const a of ATTRS) trAttr(node, a, lang);
      if (ATTR_ONLY_TAGS.has(tag(node))) return;
    }
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i], lang);
  }
  function apply(rootNode, lang = getLang()) {
    const doc = root && root.document;
    const target = rootNode || (doc && doc.body);
    if (!target) return;
    if (inSkipped(target)) return;
    walk(target, lang);
  }

  let mo = null;
  function watch() {
    const doc = root && root.document;
    if (mo || !doc || typeof root.MutationObserver !== "function") return;
    mo = new root.MutationObserver((recs) => {
      const lang = getLang();
      if (lang === "zh") return;
      for (const r of recs) {
        if (r.type === "childList") {
          r.addedNodes.forEach((n) => { if (!inSkipped(n)) walk(n, lang); });
        } else if (r.type === "characterData") {
          if (!inSkipped(r.target)) trText(r.target, lang);
        } else if (r.type === "attributes") {
          if (!skipEl(r.target) && !inSkipped(r.target)) trAttr(r.target, r.attributeName, lang);
        }
      }
    });
    mo.observe(doc.documentElement || doc, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function applyLang() {
    const doc = root && root.document;
    if (!doc) return;
    const lang = getLang();
    if (doc.documentElement) doc.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    apply(doc.body, lang);
    watch();
    try { doc.dispatchEvent(new root.CustomEvent("wb-lang", { detail: { lang } })); } catch {}
  }
  function setLang(l) {
    if (!LANGS[l]) return false;
    write(STORE_KEY, l);
    applyLang();
    return true;
  }

  // 页面里：脚本放在 body 末尾，此时 body 已在；应用脚本随后渲染的节点交给观察者
  if (root && root.document && root.document.body) applyLang();

  return { LANGS, DICT, PATTERNS, getLang, setLang, t, tr, apply, applyLang, lookup, _skipEl: skipEl };
});
