#!/usr/bin/env bash
# ============================================================================
# @dsh-external/dsh-feishu-bridge 一键安装脚本（scripts/install.sh）
#
# 用途:
#   一条命令完成「下载最新 Release tgz → 解压到安装目录 → 装配进 DSH profile
#   （dependencies 加 link: 条目 + dsh.profile.bundles 加包名）→ 建 node_modules
#   软链」。装配完成后完全重启 DSH 即生效。
#   tgz 资产名从 GitHub API（releases/latest）动态解析；API 不可用/限流时
#   回退 <版本> 拼装资产名并给出警告，下载仍走 releases/latest/download 稳定链接。
#
# 用法:
#   bash install.sh [--profile <名>] [--dir <目录>] [--skip-download] [TGZ_PATH]
#   bash install.sh -h          # 查看完整帮助
#
# 支持平台:
#   Linux / macOS（bash）。Windows 用户请按 README「方式 A」手动安装。
#
# 依赖:
#   curl、tar、node（DSH 是 node 应用，通常已满足）。
#   测试钩子: 环境变量 DSH_PROFILES_DIR 可覆盖 profile 根目录（默认 ~/.dsh/profiles）。
#
# 免责:
#   插件包从 GitHub Releases 下载
#   （https://github.com/21hbguo/dsh-feishu-bridge-plugin/releases/latest），
#   下载与执行前请确认网络与来源可信。
# ============================================================================

set -euo pipefail

# ---------- 常量 ----------
PKG_NAME="@dsh-external/dsh-feishu-bridge"
# 资产名动态解析：优先从 GitHub API（releases/latest）取 .tgz 资产名；
# 未认证 API 限流 60 次/小时，解析失败时回退 FALLBACK_VERSION 拼装并给出警告。
# 下载仍走 releases/latest/download/<资产名> 稳定链接。
RELEASE_API="https://api.github.com/repos/21hbguo/dsh-feishu-bridge-plugin/releases/latest"
RELEASE_DL="https://github.com/21hbguo/dsh-feishu-bridge-plugin/releases/latest/download"
FALLBACK_VERSION="0.0.2"
FALLBACK_TGZ_NAME="dsh-external-dsh-feishu-bridge-${FALLBACK_VERSION}.tgz"
TGZ_NAME=""
PROFILES_DIR="${DSH_PROFILES_DIR:-$HOME/.dsh/profiles}"

# ---------- 默认值 ----------
PROFILE="web"
INSTALL_DIR="$HOME/dsh-plugins/dsh-feishu-bridge"
SKIP_DOWNLOAD=0
TGZ_PATH=""

usage() {
  cat <<EOF
用法:
  bash install.sh [选项] [TGZ_PATH]

一键下载并安装 ${PKG_NAME}（飞书桥接插件）到 DSH profile：
下载最新 Release tgz → 解压 → 装配进 profile → 建软链 → 重启 DSH 生效。

选项:
  --profile <名>   目标 DSH profile 名（默认 web；配置文件位于 ~/.dsh/profiles/<名>/package.json）
  --dir <目录>     插件安装目录（默认 ~/dsh-plugins/dsh-feishu-bridge）
  --skip-download  跳过下载，使用本地已有的 tgz（需提供 TGZ_PATH 位置参数）
  -h, --help       显示本帮助并退出

位置参数:
  TGZ_PATH         本地 tgz 包路径（仅配合 --skip-download 使用）

示例:
  bash install.sh
  bash install.sh --profile my-profile --dir /opt/dsh-plugins/feishu
  bash install.sh --skip-download ./${FALLBACK_TGZ_NAME}

支持平台: Linux / macOS。依赖: curl、tar、node。
免责: 插件包从 GitHub Releases 下载（21hbguo/dsh-feishu-bridge-plugin），请确认来源可信。
EOF
}

fail() {
  echo "错误: $*" >&2
  exit 1
}

# ---------- 资产名解析 ----------
# 解析最新 Release 的 .tgz 资产名（GitHub API，未认证限流 60 次/小时）。
# 成功写入全局 TGZ_NAME；失败回退 FALLBACK_TGZ_NAME 并输出警告（stderr）。
resolve_asset_name() {
  local json name
  json="$(curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 "$RELEASE_API" 2>/dev/null)" || {
    echo "警告: 资产名解析失败（GitHub API 不可用或限流），已回退 ${FALLBACK_TGZ_NAME}，请确认 Release 资产名。" >&2
    TGZ_NAME="$FALLBACK_TGZ_NAME"
    return
  }
  name="$(printf '%s' "$json" | node -e '
    let data = "";
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => {
      try {
        const release = JSON.parse(data);
        const asset = (release.assets || []).map((a) => a.name).find((n) => typeof n === "string" && n.endsWith(".tgz"));
        process.stdout.write(asset || "");
      } catch { /* 非 JSON（如限流提示页）→ 输出空，走回退 */ }
    });
  ' 2>/dev/null || true)"
  if [ -n "$name" ]; then
    TGZ_NAME="$name"
  else
    echo "警告: 资产名解析失败（API 返回异常或未找到 .tgz 资产），已回退 ${FALLBACK_TGZ_NAME}，请确认 Release 资产名。" >&2
    TGZ_NAME="$FALLBACK_TGZ_NAME"
  fi
}

# ---------- 1. 解析参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:?--profile 需要一个参数}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:?--dir 需要一个参数}"
      shift 2
      ;;
    --skip-download)
      SKIP_DOWNLOAD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "未知选项: $1（用 -h 查看帮助）"
      ;;
    *)
      if [ -n "$TGZ_PATH" ]; then
        fail "多余的位置参数: $1（最多一个 TGZ_PATH）"
      fi
      TGZ_PATH="$1"
      shift
      ;;
  esac
done

# ---------- 2. 参数误用提前拦截 ----------
if [ "$SKIP_DOWNLOAD" = "0" ] && [ -n "$TGZ_PATH" ]; then
  fail "位置参数 TGZ_PATH 仅配合 --skip-download 使用（用 -h 查看帮助）"
fi

# ---------- 3. 检查依赖 ----------
for cmd in curl tar node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "缺少依赖命令 $cmd。Linux 请用系统包管理器安装（如 apt install $cmd），macOS 用 brew install $cmd；node 随 DSH 环境提供。"
  fi
done

# ---------- 4. 校验 profile 配置 ----------
PROFILE_JSON="$PROFILES_DIR/$PROFILE/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  echo "错误: 未找到 profile 配置文件: $PROFILE_JSON" >&2
  if [ -d "$PROFILES_DIR" ]; then
    echo "当前可用的 profiles: $(find "$PROFILES_DIR" -maxdepth 1 -mindepth 1 -type d -printf '%f ' 2>/dev/null || ls -1 "$PROFILES_DIR")" >&2
  else
    echo "（$PROFILES_DIR 不存在——请先启动过一次 DSH，或检查 DSH 的 profiles 目录位置）" >&2
  fi
  echo "请用 --profile <名> 指定正确的 profile 名（默认 web）。" >&2
  exit 1
fi

# ---------- 5. 解析安装目录（绝对路径，供 link: 与软链使用） ----------
# 展开开头的 ~
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
if ! mkdir -p "$INSTALL_DIR"; then
  fail "无法创建安装目录 $INSTALL_DIR（无权限？）"
fi
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
echo "安装目录: $INSTALL_DIR"

# ---------- 6. 获取 tgz ----------
tmp_tgz=""
cleanup() {
  if [ -n "$tmp_tgz" ] && [ -f "$tmp_tgz" ]; then
    rm -f "$tmp_tgz"
  fi
}
trap cleanup EXIT

verify_tgz() {
  # $1: tgz 路径；校验非空 + gzip tar 冒烟
  if [ ! -f "$1" ]; then
    fail "tgz 文件不存在: $1"
  fi
  if [ ! -s "$1" ]; then
    fail "tgz 文件为空: $1"
  fi
  if ! tar -tzf "$1" >/dev/null 2>&1; then
    fail "文件不是有效的 gzip tar 包: $1（可能是下载失败/网络代理返回了错误页面，或本地文件已损坏）"
  fi
  if ! tar -tzf "$1" 2>/dev/null | grep -q 'package\.json$'; then
    fail "tgz 内容异常（未找到 package.json）: $1"
  fi
}

if [ "$SKIP_DOWNLOAD" = "1" ]; then
  if [ -z "$TGZ_PATH" ]; then
    fail "--skip-download 需要提供本地 tgz 路径（位置参数 TGZ_PATH）"
  fi
  echo "使用本地 tgz: $TGZ_PATH"
  verify_tgz "$TGZ_PATH"
  tgz="$TGZ_PATH"
else
  resolve_asset_name
  echo "已解析最新 Release 资产: $TGZ_NAME"
  tmp_tgz="$(mktemp "${TMPDIR:-/tmp}/dsh-feishu-bridge.XXXXXX")"
  echo "下载 $RELEASE_DL/$TGZ_NAME"
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 600 -o "$tmp_tgz" "$RELEASE_DL/$TGZ_NAME" || {
    code=$?
    fail "下载失败（curl 退出码 ${code:-?}）。请检查网络，或稍后重试；也可手动下载 tgz 后用 --skip-download 安装。"
  }
  verify_tgz "$tmp_tgz"
  echo "下载完成（$(du -h "$tmp_tgz" | cut -f1)）"
  tgz="$tmp_tgz"
fi

# ---------- 7. 解压到安装目录 ----------
if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  overwrite=1
  if [ -t 0 ]; then
    printf '目录 %s 已存在且非空。覆盖更新？[y/N] ' "$INSTALL_DIR"
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|YES) overwrite=1 ;;
      *) overwrite=0 ;;
    esac
  else
    echo "（非交互模式）目录 $INSTALL_DIR 已存在且非空，默认覆盖更新。"
  fi
  if [ "$overwrite" = "1" ]; then
    echo "解压覆盖到 $INSTALL_DIR ..."
    tar -xzf "$tgz" -C "$INSTALL_DIR" --strip-components=1
  else
    echo "保留现有目录，跳过解压，继续装配。"
  fi
else
  mkdir -p "$INSTALL_DIR"
  echo "解压到 $INSTALL_DIR ..."
  tar -xzf "$tgz" -C "$INSTALL_DIR" --strip-components=1
fi

# ---------- 8. 用 node 编辑 profile package.json（备份 → 写回） ----------
BACKUP="$PROFILE_JSON.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$PROFILE_JSON" "$BACKUP"
echo "已备份原配置: $BACKUP"

echo "装配到 profile '$PROFILE' ..."
PROFILE_JSON="$PROFILE_JSON" PKG_NAME="$PKG_NAME" INSTALL_DIR="$INSTALL_DIR" node <<'EOF'
const fs = require('fs');
const file = process.env.PROFILE_JSON;
const name = process.env.PKG_NAME;
const target = process.env.INSTALL_DIR;
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[name] = 'link:' + target;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
if (!pkg.dsh.profile.bundles.includes(name)) {
  pkg.dsh.profile.bundles.push(name);
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('  dependencies.' + name + ' = link:' + target);
console.log('  dsh.profile.bundles 包含 ' + name + ': ' + pkg.dsh.profile.bundles.includes(name));
EOF

# ---------- 9. 建软链 ----------
NODE_MODULES_LINK_DIR="$PROFILES_DIR/$PROFILE/node_modules/@dsh-external"
mkdir -p "$NODE_MODULES_LINK_DIR"
ln -sfn "$INSTALL_DIR" "$NODE_MODULES_LINK_DIR/dsh-feishu-bridge"
echo "已建软链: $NODE_MODULES_LINK_DIR/dsh-feishu-bridge -> $INSTALL_DIR"

# ---------- 10. 完成信息 ----------
cat <<EOF

✅ 安装完成！

  插件目录: $INSTALL_DIR
  profile:  $PROFILE（配置备份: $BACKUP）
    - dependencies 已写入 "@dsh-external/dsh-feishu-bridge": "link:$INSTALL_DIR"
    - dsh.profile.bundles 已包含 "@dsh-external/dsh-feishu-bridge"
    - 软链: $PROFILES_DIR/$PROFILE/node_modules/@dsh-external/dsh-feishu-bridge -> $INSTALL_DIR

下一步:
  完全退出并重启 DSH（不是刷新页面）。重启后插件随 profile 装配自动加载；
  在飞书里私聊机器人发送 /help 验证。
EOF

if grep -q 'super-injector' "$PROFILE_JSON" 2>/dev/null; then
  echo "提示: 检测到 dsh-super-injector——也可以使用 dev_install_package 命令完成装配（见 README 方式 B）。"
fi
