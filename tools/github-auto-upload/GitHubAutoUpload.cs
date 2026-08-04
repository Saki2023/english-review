using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace EnglishReviewGitHubUpload
{
    internal sealed class CommandResult
    {
        public int ExitCode;
        public string Output = "";
        public bool TimedOut;
    }

    internal sealed class UploadResult
    {
        public bool Success;
        public string Status = "";
        public string Message = "";
    }

    internal sealed class UploadForm : Form
    {
        private readonly Label statusLabel;
        private readonly TextBox logBox;
        private readonly Button closeButton;

        public UploadForm()
        {
            Text = "每日英语复习 · GitHub 自动上传";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(720, 470);
            MinimumSize = new Size(620, 410);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Regular, GraphicsUnit.Point);

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 104;
            header.Padding = new Padding(24, 18, 24, 12);
            header.BackColor = Color.FromArgb(236, 247, 244);
            Controls.Add(header);

            Label title = new Label();
            title.Text = "GitHub 自动上传";
            title.AutoSize = true;
            title.Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold, GraphicsUnit.Point);
            title.Location = new Point(22, 16);
            header.Controls.Add(title);

            statusLabel = new Label();
            statusLabel.Text = "正在准备……";
            statusLabel.AutoSize = true;
            statusLabel.ForeColor = Color.FromArgb(31, 110, 82);
            statusLabel.Location = new Point(25, 61);
            header.Controls.Add(statusLabel);

            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 58;
            footer.Padding = new Padding(20, 10, 20, 10);
            Controls.Add(footer);

            closeButton = new Button();
            closeButton.Text = "关闭";
            closeButton.Enabled = false;
            closeButton.Width = 110;
            closeButton.Height = 34;
            closeButton.Dock = DockStyle.Right;
            closeButton.Click += delegate { Close(); };
            footer.Controls.Add(closeButton);

            Label note = new Label();
            note.Text = "只上传已提交内容；不会自动添加或提交文件，也不会修改任何网络设置。";
            note.AutoSize = true;
            note.ForeColor = Color.DimGray;
            note.Location = new Point(20, 18);
            footer.Controls.Add(note);

            Panel content = new Panel();
            content.Dock = DockStyle.Fill;
            content.Padding = new Padding(20, 18, 20, 12);
            Controls.Add(content);

            logBox = new TextBox();
            logBox.Dock = DockStyle.Fill;
            logBox.Multiline = true;
            logBox.ReadOnly = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.BackColor = Color.FromArgb(249, 251, 250);
            logBox.BorderStyle = BorderStyle.FixedSingle;
            logBox.Font = new Font("Consolas", 10F, FontStyle.Regular, GraphicsUnit.Point);
            content.Controls.Add(logBox);

            Shown += async delegate
            {
                AppendLog("程序已启动，正在自动检查仓库和待上传提交。\r\n");
                UploadResult result = await Task.Run<UploadResult>(new Func<UploadResult>(RunUpload));
                statusLabel.Text = result.Status;
                statusLabel.ForeColor = result.Success ? Color.FromArgb(31, 110, 82) : Color.FromArgb(174, 68, 52);
                AppendLog("\r\n" + result.Message + "\r\n");
                closeButton.Enabled = true;
                Activate();
            };
        }

        private void AppendLog(string value)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(AppendLog), value);
                return;
            }
            logBox.AppendText(value);
        }

        private UploadResult RunUpload()
        {
            try
            {
                string repository = FindRepository();
                if (String.IsNullOrEmpty(repository))
                {
                    return Failure("没有找到程序仓库", "请把“GitHub自动上传.exe”放在“三年英语学习计划”目录中再双击。程序需要找到“每日英语复习”仓库。");
                }
                AppendLog("已找到“每日英语复习”程序仓库。\r\n");

                string git = FindWorkingGit(repository);
                if (String.IsNullOrEmpty(git))
                {
                    return Failure("没有找到可用的完整 Git", "当前找到的 Git 无法正常启动。请安装 Git for Windows，或保留 Codex 完整运行环境后再试。");
                }
                AppendLog("已找到可用的完整 Git。\r\n");

                CommandResult branch = RunGit(git, repository, "symbolic-ref --quiet --short HEAD", 15, null);
                if (branch.ExitCode != 0 || branch.Output.Trim() != "main")
                {
                    return Failure("当前不是 main 分支", "为了避免上传错误分支，程序已经停止。当前分支必须是 main。");
                }

                CommandResult origin = RunGit(git, repository, "remote get-url origin", 15, null);
                if (origin.ExitCode != 0 || String.IsNullOrWhiteSpace(origin.Output))
                {
                    return Failure("没有找到 origin", "仓库尚未配置 GitHub 远程地址 origin，程序没有执行上传。");
                }

                CommandResult dirty = RunGit(git, repository, "status --short", 20, null);
                int uncommittedCount = dirty.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Length;
                if (uncommittedCount > 0)
                {
                    AppendLog("提醒：发现 " + uncommittedCount + " 项未提交修改；这些内容不会被本工具上传。\r\n");
                }

                Dictionary<string, string> environment = BuildGitEnvironment(git, repository, origin.Output.Trim());
                CommandResult aheadBefore = RunGit(git, repository, "rev-list --count origin/main..HEAD", 15, environment);
                int pendingBefore = ParseCount(aheadBefore.Output);
                AppendLog(pendingBefore > 0
                    ? "发现 " + pendingBefore + " 个已提交但尚未上传的提交，正在上传……\r\n"
                    : "本地没有已知的待上传提交，正在向 GitHub 做最终确认……\r\n");

                CommandResult push = RunGit(git, repository, "push --porcelain origin main", 150, environment);
                if (push.TimedOut)
                {
                    return Failure("上传超时", "GitHub 在 150 秒内没有完成响应。程序没有修改网络设置，请稍后重试。");
                }
                if (push.ExitCode != 0)
                {
                    return Failure("上传失败", ExplainGitFailure(push.Output));
                }

                CommandResult aheadAfter = RunGit(git, repository, "rev-list --count origin/main..HEAD", 15, environment);
                int pendingAfter = ParseCount(aheadAfter.Output);
                if (pendingAfter > 0)
                {
                    return Failure("上传后仍有待处理提交", "Git 返回成功，但仍检测到 " + pendingAfter + " 个待上传提交。请关闭程序后重试或查看 GitHub 提交页面。");
                }

                if (pendingBefore == 0)
                {
                    return Success("无需上传", "GitHub 已确认：当前已提交内容没有需要上传的更新。" + UncommittedSuffix(uncommittedCount));
                }
                return Success("上传成功", "已将 " + pendingBefore + " 个提交上传到 GitHub 的 main 分支。" + UncommittedSuffix(uncommittedCount));
            }
            catch (Exception exception)
            {
                return Failure("程序发生异常", "异常类型：" + exception.GetType().Name + "。请保留此窗口并把错误类型告诉开发窗口。");
            }
        }

        private static string UncommittedSuffix(int count)
        {
            return count > 0 ? " 另有 " + count + " 项未提交修改没有上传。" : "";
        }

        private static UploadResult Success(string status, string message)
        {
            return new UploadResult { Success = true, Status = status, Message = message };
        }

        private static UploadResult Failure(string status, string message)
        {
            return new UploadResult { Success = false, Status = status, Message = message };
        }

        private static int ParseCount(string value)
        {
            int result;
            return Int32.TryParse((value ?? "").Trim(), out result) ? Math.Max(0, result) : 0;
        }

        private static string FindRepository()
        {
            string executableDirectory = AppDomain.CurrentDomain.BaseDirectory;
            List<string> candidates = new List<string>();
            candidates.Add(Path.Combine(executableDirectory, "每日英语复习"));
            candidates.Add(executableDirectory);
            candidates.Add(Environment.CurrentDirectory);
            DirectoryInfo cursor = new DirectoryInfo(executableDirectory);
            for (int index = 0; index < 5 && cursor != null; index++, cursor = cursor.Parent)
            {
                candidates.Add(cursor.FullName);
                candidates.Add(Path.Combine(cursor.FullName, "每日英语复习"));
            }
            foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    if (Directory.Exists(candidate) && (Directory.Exists(Path.Combine(candidate, ".git")) || File.Exists(Path.Combine(candidate, ".git"))))
                    {
                        return Path.GetFullPath(candidate);
                    }
                }
                catch { }
            }
            return "";
        }

        private static string FindWorkingGit(string repository)
        {
            List<string> candidates = new List<string>();
            string configured = Environment.GetEnvironmentVariable("ENGLISH_REVIEW_GIT_EXE") ?? "";
            if (!String.IsNullOrWhiteSpace(configured)) candidates.Add(configured);
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(userProfile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "cmd", "git.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd", "git.exe"));
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (!String.IsNullOrEmpty(programFilesX86)) candidates.Add(Path.Combine(programFilesX86, "Git", "cmd", "git.exe"));
            candidates.Add(Path.Combine(Directory.GetParent(repository).FullName, ".tools", "git-network", "mingw64", "bin", "git.exe"));

            try
            {
                string runtimeRoot = Path.Combine(userProfile, ".cache", "codex-runtimes");
                if (Directory.Exists(runtimeRoot))
                {
                    foreach (string directory in Directory.GetDirectories(runtimeRoot))
                    {
                        candidates.Add(Path.Combine(directory, "dependencies", "native", "git", "cmd", "git.exe"));
                    }
                }
            }
            catch { }

            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string directory in pathValue.Split(Path.PathSeparator))
            {
                if (!String.IsNullOrWhiteSpace(directory)) candidates.Add(Path.Combine(directory.Trim('"'), "git.exe"));
            }

            foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    CommandResult version = RunGit(candidate, repository, "--version", 10, null);
                    if (version.ExitCode == 0 && version.Output.IndexOf("git version", StringComparison.OrdinalIgnoreCase) >= 0) return candidate;
                }
                catch { }
            }
            return "";
        }

        private static Dictionary<string, string> BuildGitEnvironment(string git, string repository, string origin)
        {
            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            environment["GIT_TERMINAL_PROMPT"] = "0";
            CommandResult sshCommand = RunGit(git, repository, "config --local --get core.sshCommand", 10, null);
            if ((origin.StartsWith("git@", StringComparison.OrdinalIgnoreCase) || origin.StartsWith("ssh://", StringComparison.OrdinalIgnoreCase))
                && sshCommand.ExitCode == 0 && !String.IsNullOrWhiteSpace(sshCommand.Output))
            {
                environment["GIT_SSH_COMMAND"] = sshCommand.Output.Trim() + " -o BatchMode=yes";
            }
            return environment;
        }

        private static CommandResult RunGit(string git, string repository, string arguments, int timeoutSeconds, IDictionary<string, string> environment)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = git;
            startInfo.Arguments = arguments;
            startInfo.WorkingDirectory = repository;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.StandardOutputEncoding = Encoding.UTF8;
            startInfo.StandardErrorEncoding = Encoding.UTF8;
            if (environment != null)
            {
                foreach (KeyValuePair<string, string> pair in environment) startInfo.EnvironmentVariables[pair.Key] = pair.Value;
            }

            using (Process process = new Process())
            {
                process.StartInfo = startInfo;
                process.Start();
                Task<string> stdout = process.StandardOutput.ReadToEndAsync();
                Task<string> stderr = process.StandardError.ReadToEndAsync();
                bool completed = process.WaitForExit(Math.Max(1, timeoutSeconds) * 1000);
                if (!completed)
                {
                    try { process.Kill(); } catch { }
                }
                Task.WaitAll(new Task[] { stdout, stderr }, 5000);
                string combined = Sanitize((stdout.IsCompleted ? stdout.Result : "") + "\n" + (stderr.IsCompleted ? stderr.Result : ""));
                return new CommandResult { ExitCode = completed ? process.ExitCode : -1, Output = combined.Trim(), TimedOut = !completed };
            }
        }

        private static string ExplainGitFailure(string output)
        {
            string safe = Sanitize(output);
            if (Regex.IsMatch(safe, "Permission denied|publickey|Could not open a connection to your authentication agent|Load key", RegexOptions.IgnoreCase))
            {
                return "SSH 密钥尚未被当前 Windows 会话解锁。请先把密钥加入 ssh-agent，再双击本工具；密钥和口令不会由本工具保存。";
            }
            if (Regex.IsMatch(safe, "Could not resolve host|Connection timed out|Connection reset|Failed to connect|Network is unreachable|Connection closed", RegexOptions.IgnoreCase))
            {
                return "无法连接 GitHub，属于 DNS 或网络连接问题。程序没有修改代理、DNS、路由、网卡或防火墙；请等待网络恢复后重试。";
            }
            if (Regex.IsMatch(safe, "non-fast-forward|fetch first|rejected", RegexOptions.IgnoreCase))
            {
                return "GitHub 上的 main 比本地更新，为避免覆盖远端，程序已停止。需要先拉取并合并远端提交。";
            }
            if (Regex.IsMatch(safe, "dubious ownership|safe.directory", RegexOptions.IgnoreCase))
            {
                return "Git 拒绝了当前仓库所有权。请在你的 PowerShell 中把该仓库加入 safe.directory 后重试。";
            }
            string firstLine = safe.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            return String.IsNullOrWhiteSpace(firstLine) ? "Git 返回了失败状态，但没有提供详细文本。" : "Git 返回：" + firstLine;
        }

        private static string Sanitize(string value)
        {
            string safe = value ?? "";
            safe = Regex.Replace(safe, "(?i)(Bearer\\s+)[A-Za-z0-9._~+/=-]+", "$1<已隐藏>");
            safe = Regex.Replace(safe, "(?i)(https?://)[^/@\\s]+@", "$1<已隐藏>@");
            safe = Regex.Replace(safe, "(?i)(SYNC_(READ|WRITE)_TOKEN|API_TOKEN)\\s*[=:]\\s*[^\\s,;]+", "$1=<已隐藏>");
            return safe;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UploadForm());
        }
    }
}
