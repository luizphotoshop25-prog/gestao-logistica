using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class RepairManifest
{
    public string SourceVersion;
    public string TargetVersion;
    public string SourceSha256;
    public string TargetSha256;

    public static RepairManifest Load()
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RepairManifest.txt"))
        {
            if (stream == null) throw new InvalidDataException("Manifesto de reparo ausente.");
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                string[] lines = reader.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var values = new System.Collections.Generic.Dictionary<string, string>(StringComparer.Ordinal);
                foreach (string line in lines)
                {
                    int separator = line.IndexOf('=');
                    if (separator <= 0) throw new InvalidDataException("Manifesto de reparo inválido.");
                    string key = line.Substring(0, separator);
                    if (values.ContainsKey(key)) throw new InvalidDataException("Manifesto de reparo inválido.");
                    values.Add(key, line.Substring(separator + 1));
                }
                return new RepairManifest {
                    SourceVersion = Required(values, "sourceVersion"),
                    TargetVersion = Required(values, "targetVersion"),
                    SourceSha256 = Required(values, "sourceSha256").ToUpperInvariant(),
                    TargetSha256 = Required(values, "targetSha256").ToUpperInvariant(),
                };
            }
        }
    }

    private static string Required(System.Collections.Generic.Dictionary<string, string> values, string key)
    {
        string value;
        if (!values.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value))
            throw new InvalidDataException("Manifesto de reparo incompleto.");
        return value;
    }
}

internal sealed class RepairForm : Form
{
    private readonly Label status = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private bool started;

    public RepairForm()
    {
        Text = "Reparo do Gestão Logística";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(510, 176);
        BackColor = Color.White;
        status.SetBounds(26, 24, 455, 58);
        status.Font = new Font("Segoe UI", 11f, FontStyle.Regular);
        status.Text = "Preparando o reparo seguro da instalação…";
        progress.SetBounds(26, 104, 455, 16);
        progress.Style = ProgressBarStyle.Marquee;
        Controls.Add(status);
        Controls.Add(progress);
        Shown += async (_, __) => await RunRepair();
    }

    private async Task RunRepair()
    {
        if (started) return;
        started = true;
        try
        {
            string message = await Task.Run(() => RepairEngine.ApplyAndLaunch());
            status.Text = message;
            progress.Style = ProgressBarStyle.Blocks;
            progress.Value = 100;
            MessageBox.Show(this, message, "Gestão Logística", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }
        catch (Exception error)
        {
            status.Text = "O reparo não foi concluído. Nenhuma versão incompatível será substituída.";
            progress.Style = ProgressBarStyle.Blocks;
            progress.Value = 0;
            MessageBox.Show(this, error.Message, "Não foi possível reparar o Gestão Logística", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

internal static class RepairEngine
{
    private const string ProductExecutable = "Gestão Logística.exe";
    private static readonly RepairManifest Manifest = RepairManifest.Load();

    public static string ApplyAndLaunch()
    {
        string root = GetInstallRoot();
        ValidateInstallPath(root);
        string resources = Path.Combine(root, "resources");
        string archive = Path.Combine(resources, "app.asar");
        string executable = Path.Combine(root, ProductExecutable);
        if (!File.Exists(executable) || !File.Exists(archive))
            throw new FileNotFoundException("A instalação esperada do Gestão Logística não foi encontrada.");
        ValidateNoReparsePoint(resources);
        ValidateNoReparsePoint(executable);
        ValidateNoReparsePoint(archive);
        string installedHash = HashFile(archive);
        bool alreadyRepaired = FixedTimeEquals(installedHash, Manifest.TargetSha256);
        if (!alreadyRepaired && !FixedTimeEquals(installedHash, Manifest.SourceSha256))
            throw new InvalidDataException("Esta instalação não corresponde à versão 0.1.13 original nem à versão já reparada. Nenhum arquivo foi alterado.");
        CloseApplication(root);
        if (!FixedTimeEquals(HashFile(archive), installedHash))
            throw new InvalidDataException("O arquivo do aplicativo mudou durante a verificação. Nenhuma alteração foi feita.");

        string backup = "";
        string temporary = Path.Combine(resources, ".app.asar.repair-" + Guid.NewGuid().ToString("N") + ".tmp");
        bool replaced = false;
        try
        {
            if (!alreadyRepaired)
            {
                WriteEmbeddedArchive(temporary);
                if (!FixedTimeEquals(HashFile(temporary), Manifest.TargetSha256))
                    throw new InvalidDataException("A validação do hash do reparo falhou.");

                backup = CreateBackup(resources, archive);
                File.Replace(temporary, archive, null);
                replaced = true;
                if (!FixedTimeEquals(HashFile(archive), Manifest.TargetSha256))
                    throw new InvalidDataException("O arquivo substituído não passou na validação final de hash.");
            }

            Process launched = LaunchAndWaitForWindow(executable);
            if (launched.MainWindowTitle.IndexOf("Recuperação", StringComparison.OrdinalIgnoreCase) >= 0)
                throw new InvalidOperationException("O aplicativo abriu em modo de recuperação; o reparo foi revertido.");
            return alreadyRepaired
                ? "Esta instalação já estava reparada. Nenhum arquivo foi alterado e o Gestão Logística foi aberto."
                : "Reparo concluído. O backup da versão anterior foi preservado e o Gestão Logística foi aberto.";
        }
        catch
        {
            if (replaced && !String.IsNullOrEmpty(backup)) RestoreBackup(archive, backup, root);
            throw;
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    private static string GetInstallRoot()
    {
#if REPAIR_TEST_MODE
        string testRoot = Environment.GetEnvironmentVariable("GESTAO_REPAIR_TEST_ROOT");
        if (!String.IsNullOrWhiteSpace(testRoot)) return Path.GetFullPath(testRoot);
#endif
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.GetFullPath(Path.Combine(local, "Programs", "gestao-logistica"));
    }

    private static void ValidateInstallPath(string root)
    {
        string expectedParent = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"));
#if REPAIR_TEST_MODE
        string testRoot = Environment.GetEnvironmentVariable("GESTAO_REPAIR_TEST_ROOT");
        if (!String.IsNullOrWhiteSpace(testRoot)) expectedParent = Path.GetDirectoryName(Path.GetFullPath(testRoot));
#endif
        string normalizedParent = expectedParent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!root.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("O caminho de instalação está fora da pasta permitida.");
        ValidateNoReparsePoint(expectedParent);
        ValidateNoReparsePoint(root);
    }

    private static void ValidateNoReparsePoint(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("O caminho de instalação contém um link inesperado.");
    }

    private static void CloseApplication(string root)
    {
        string expectedExecutable = Path.GetFullPath(Path.Combine(root, ProductExecutable));
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    string processPath = Path.GetFullPath(process.MainModule.FileName);
                    if (!String.Equals(processPath, expectedExecutable, StringComparison.OrdinalIgnoreCase)) continue;
                    process.CloseMainWindow();
                    if (!process.WaitForExit(15000))
                        throw new IOException("Feche o Gestão Logística e execute o reparador novamente.");
                }
                catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
    }

    private static void WriteEmbeddedArchive(string destination)
    {
        using (Stream patch = Assembly.GetExecutingAssembly().GetManifestResourceStream("RepairPatch.zip"))
        {
            if (patch == null) throw new InvalidDataException("O conteúdo do reparo está ausente.");
            using (ZipArchive zip = new ZipArchive(patch, ZipArchiveMode.Read, false))
            {
                if (zip.Entries.Count != 1 || !String.Equals(zip.Entries[0].FullName, "app.asar", StringComparison.Ordinal))
                    throw new InvalidDataException("O conteúdo do reparo não passou na validação de caminho.");
                using (Stream input = zip.Entries[0].Open())
                using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    input.CopyTo(output);
                if (new FileInfo(destination).Length < 1024 * 1024)
                    throw new InvalidDataException("O arquivo do aplicativo está incompleto.");
            }
        }
    }

    private static string CreateBackup(string resources, string archive)
    {
        string backupDirectory = Path.Combine(resources, "repair-backup-0.1.13");
        if (!Directory.Exists(backupDirectory)) Directory.CreateDirectory(backupDirectory);
        ValidateNoReparsePoint(backupDirectory);
        string backup = Path.Combine(backupDirectory, "app.asar");
        if (File.Exists(backup))
        {
            ValidateNoReparsePoint(backup);
            if (FixedTimeEquals(HashFile(backup), Manifest.SourceSha256)) return backup;
            backup = Path.Combine(backupDirectory, "app.asar-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + ".bak");
        }
        File.Copy(archive, backup, false);
        if (!FixedTimeEquals(HashFile(backup), Manifest.SourceSha256))
            throw new InvalidDataException("O backup preventivo não passou na validação de hash.");
        return backup;
    }

    private static Process LaunchAndWaitForWindow(string executable)
    {
        Process process = Process.Start(new ProcessStartInfo {
            FileName = executable,
            WorkingDirectory = Path.GetDirectoryName(executable),
            UseShellExecute = true,
        });
        if (process == null) throw new InvalidOperationException("O Windows não iniciou o Gestão Logística.");
        DateTime deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            process.Refresh();
            if (process.HasExited) throw new InvalidOperationException("O Gestão Logística encerrou durante a validação de inicialização.");
            if (process.MainWindowHandle != IntPtr.Zero) return process;
            Task.Delay(250).Wait();
        }
        try { process.CloseMainWindow(); process.WaitForExit(3000); } catch { }
        throw new TimeoutException("O Gestão Logística não abriu uma janela dentro do tempo esperado.");
    }

    private static void RestoreBackup(string archive, string backup, string root)
    {
        try
        {
            string executable = Path.Combine(root, ProductExecutable);
            foreach (Process process in Process.GetProcesses())
            {
                using (process)
                {
                    try
                    {
                        if (process.MainWindowHandle != IntPtr.Zero
                            && String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase))
                        {
                            process.CloseMainWindow();
                            process.WaitForExit(5000);
                        }
                    }
                    catch { }
                }
            }
            string restore = archive + ".rollback-" + Guid.NewGuid().ToString("N");
            File.Copy(backup, restore, false);
            File.Replace(restore, archive, null);
            if (!FixedTimeEquals(HashFile(archive), Manifest.SourceSha256))
                throw new IOException("O rollback não passou na validação de hash.");
        }
        catch (Exception rollbackError)
        {
            throw new IOException("O reparo falhou e o rollback automático também falhou. O backup está preservado em: " + backup, rollbackError);
        }
    }

    private static string HashFile(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        int difference = 0;
        for (int index = 0; index < left.Length; index++) difference |= Char.ToUpperInvariant(left[index]) ^ Char.ToUpperInvariant(right[index]);
        return difference == 0;
    }
}

internal static class Program
{
    [STAThread]
    private static int Main()
    {
#if REPAIR_TEST_MODE
        try
        {
            string resultPath = Environment.GetEnvironmentVariable("GESTAO_REPAIR_TEST_RESULT");
            if (String.IsNullOrWhiteSpace(resultPath)) throw new InvalidOperationException("O teste não definiu o arquivo de resultado.");
            string result = RepairEngine.ApplyAndLaunch();
            File.WriteAllText(resultPath, "OK\n" + result, Encoding.UTF8);
            return 0;
        }
        catch (Exception error)
        {
            string resultPath = Environment.GetEnvironmentVariable("GESTAO_REPAIR_TEST_RESULT");
            if (!String.IsNullOrWhiteSpace(resultPath)) File.WriteAllText(resultPath, "ERROR\n" + error.GetType().Name + "\n" + error.Message, Encoding.UTF8);
            return 1;
        }
#else
        using (System.Threading.Mutex mutex = new System.Threading.Mutex(false, "Local\\GestaoLogisticaRepair014"))
        {
            bool acquired = false;
            try { acquired = mutex.WaitOne(0); } catch (System.Threading.AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                MessageBox.Show("O reparador já está em execução.", "Gestão Logística", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new RepairForm());
        }
        return 0;
#endif
    }
}
