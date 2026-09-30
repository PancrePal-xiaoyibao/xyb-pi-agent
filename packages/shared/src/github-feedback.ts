/**
 * 反馈入口的目标仓库（小胰宝 fork 自有）。
 *
 * 上游把「反馈」和「发布产物」共用一个常量，指向 vastsa/PI-Desktop。
 * 对患者产品这是隐私问题：患者点「反馈问题」会把 issue 提到上游仓库，
 * 而报告里往往夹带病情、用药、就诊信息，不该落到第三方 issue tracker。
 */
export const GITHUB_FEEDBACK_REPO = "PancrePal-xiaoyibao/xyb-pi-agent";

/**
 * 发布产物所在仓库。远程 host（pi-host）按 `v<version>` 从这里取 tarball 与 sha256。
 *
 * 0.16.1 起本仓库自己发布这些产物（release.yml 会一并上传
 * pi-host-<version>-linux-<arch>.tar.gz 与校验文件），所以与反馈入口是同一个仓库。
 * 此前沿用上游时，远程 host 实际装的是上游的 sidecar，版本号相同也看不出来。
 */
export const GITHUB_REPO = GITHUB_FEEDBACK_REPO;
export const GITHUB_BUG_TEMPLATE = "bug_report.yml";
export const GITHUB_ISSUE_ORIGIN = "https://github.com";

export type FeedbackIssueContext = {
  version: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  hostVersion?: string;
};

export type FeedbackOsLabel = "macOS" | "Windows" | "Linux" | "Other";

export function osLabelForFeedback(platform: string): FeedbackOsLabel {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return "Other";
  }
}

export function formatFeedbackEnvironment(info: FeedbackIssueContext): string {
  const host = info.hostVersion?.trim() || "unknown";
  return `xyb-pi ${info.version} · ${info.platform} ${info.arch} · protocol ${info.protocolVersion} · host ${host}`;
}

export function buildBugReportUrl(info: FeedbackIssueContext): string {
  const url = new URL(`${GITHUB_ISSUE_ORIGIN}/${GITHUB_FEEDBACK_REPO}/issues/new`);
  url.searchParams.set("template", GITHUB_BUG_TEMPLATE);
  url.searchParams.set("app-version", info.version);
  url.searchParams.set("os", osLabelForFeedback(info.platform));
  url.searchParams.set("environment", formatFeedbackEnvironment(info));
  return url.toString();
}

export function assertFeedbackIssueUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid feedback URL");
  }
  if (parsed.origin !== GITHUB_ISSUE_ORIGIN) {
    throw new Error("invalid feedback URL origin");
  }
  if (parsed.pathname !== `/${GITHUB_FEEDBACK_REPO}/issues/new`) {
    throw new Error("invalid feedback URL path");
  }
  if (parsed.searchParams.get("template") !== GITHUB_BUG_TEMPLATE) {
    throw new Error("invalid feedback URL template");
  }
}
