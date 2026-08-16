/**
 * 表情回执选择逻辑（纯函数模块）。
 *
 * 借鉴自 amlyczz/dsh-lark-link (MIT) src/common/reactions.ts：
 * 飞书 addReaction 的 emoji_type 是**白名单枚举**，不在名单内的类型会直接
 * 报 400 / ErrCode 231001 "reaction type is invalid"。lark-link 用一份实测
 * 通过的 emoji_type 全集（190 枚）做过滤器，本模块直接采用该已验证集合与
 * 「随机池过滤 + DONE 排除」思路，化用为两个无状态函数 pickReaction /
 * doneReaction，供 index.ts 接线时在合适时机调用。
 *
 * ⚠️ 发送表情需要应用具备 `im:message.reaction` scope（读/写表情权限）；
 * 本模块只提供「选哪个表情」的决策逻辑，**不负责发送**——发送时机与
 * 权限申请由 index.ts 接线轮处理（setup.ts 的 addons 预填也需补该 scope）。
 */

/** 全部飞书有效 emoji_type 值（open.feishu.cn 表情接口实测集合，2026-08 验证）。 */
export const VALID_EMOJI_TYPES: ReadonlySet<string> = new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon",
])

/**
 * 完成标记表情——任务完成时打在触发消息上（如 ✅ DONE）。
 * 恒为 "DONE"，且永不进入随机池（防随机回执与完成标记混淆）。
 */
export const DONE_EMOJI = "DONE"

/**
 * 默认随机回执池（全部飞书实测有效）。
 * 注意 emoji_type 大小写敏感：`Fire` 有效而 `FIRE` 无效；
 * ROCKET / SUN / WHITE_CHECK_MARK 不是飞书合法 emoji_type，会导致 400。
 */
export const DEFAULT_RANDOM_POOL: readonly string[] = [
	"THUMBSUP",
	"OK",
	"HEART",
	"LAUGH",
	"SMILE",
	"WOW",
	"CLAP",
	"Fire",
]

/** 该 emoji_type 是否为飞书实测有效值（大小写敏感）。 */
export function isFeishuEmoji(type: string): boolean {
	return VALID_EMOJI_TYPES.has(type)
}

/**
 * 完成回执表情。约定固定为 DONE（飞书 ✅ 的 emoji_type 即 "DONE"）。
 * 返回类型永远合法，可直接用于 im:message.reaction addReaction。
 */
export function doneReaction(): string {
	return DONE_EMOJI
}

/**
 * 从随机池中挑一个收到消息的回执表情；永不返回 DONE 完成标记。
 *
 * 过滤规则（借鉴 lark-link createReactionPicker）：
 * 1. 传入池中不在 VALID_EMOJI_TYPES 的项直接剔除（过期配置无法 400 桥）；
 * 2. 剔除 DONE（完成标记不参与随机池）；
 * 3. 过滤后为空 → 回退 DEFAULT_RANDOM_POOL（同样剔除 DONE）。
 * 理论上永不返回 undefined（默认池非空），保留 undefined 仅作类型完备。
 *
 * @param pool 可选的自定义随机池；缺省用 DEFAULT_RANDOM_POOL。
 */
export function pickReaction(pool?: readonly string[]): string | undefined {
	const source = pool ?? DEFAULT_RANDOM_POOL
	const validPool = source.filter((t) => VALID_EMOJI_TYPES.has(t) && t !== DONE_EMOJI)
	const effective =
		validPool.length > 0
			? validPool
			: DEFAULT_RANDOM_POOL.filter((t) => t !== DONE_EMOJI)
	if (effective.length === 0) return undefined
	return effective[Math.floor(Math.random() * effective.length)]
}
