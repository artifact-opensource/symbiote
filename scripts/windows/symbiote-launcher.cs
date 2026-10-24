using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class SymbioteLauncher
{
    private const string AppUserModelId = "com.artifactvirtual.symbiote";

    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        if (args.Length == 1 && args[0] == "--configure-shortcut")
        {
            try
            {
                ConfigureShortcut(root);
                return 0;
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "Symbiote launcher setup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        string script = Path.Combine(root, "scripts", "start-desktop.mjs");
        if (!File.Exists(script))
        {
            MessageBox.Show("The Symbiote startup script is missing:\n" + script, "Symbiote could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        try
        {
            var output = new StringBuilder();
            var info = new ProcessStartInfo("node.exe", Quote(script));
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;

            using (Process process = Process.Start(info))
            {
                process.OutputDataReceived += (sender, eventArgs) => Append(output, eventArgs.Data);
                process.ErrorDataReceived += (sender, eventArgs) => Append(output, eventArgs.Data);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    string details = output.ToString();
                    if (details.Length > 3500) details = details.Substring(details.Length - 3500);
                    MessageBox.Show(
                        "Symbiote did not start successfully. Check .session\\desktop-launch.log for Gateway diagnostics.\n\n" + details,
                        "Symbiote could not start",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return process.ExitCode;
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Could not run the Symbiote launcher. Confirm Node.js 20 or newer is installed and available on PATH.\n\n" + error.Message,
                "Symbiote could not start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Append(StringBuilder output, string line)
    {
        if (!String.IsNullOrEmpty(line)) output.AppendLine(line);
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ConfigureShortcut(string root)
    {
        string executable = Path.Combine(root, "symbiote.exe");
        string icon = Path.Combine(root, "assets", "biohazard_green.ico");
        string shortcutPath = Path.Combine(root, "symbiote.link.lnk");
        if (!File.Exists(executable)) throw new FileNotFoundException("The launcher executable was not created.", executable);
        if (!File.Exists(icon)) throw new FileNotFoundException("The green Symbiote icon is missing.", icon);

        IShellLinkW shellLink = (IShellLinkW)new ShellLink();
        shellLink.SetPath(executable);
        shellLink.SetWorkingDirectory(root);
        shellLink.SetIconLocation(icon, 0);
        shellLink.SetDescription("Start Symbiote desktop and Gateway");

        var key = new PropertyKey
        {
            FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            PropertyId = 5
        };
        IntPtr appId = Marshal.StringToCoTaskMemUni(AppUserModelId);
        try
        {
            var value = new PropVariant { Type = 31, Pointer = appId };
            ((IPropertyStore)shellLink).SetValue(ref key, ref value);
            ((IPropertyStore)shellLink).Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(appId);
        }

        ((IPersistFile)shellLink).Save(shortcutPath, true);
        Marshal.FinalReleaseComObject(shellLink);
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath(IntPtr file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription(IntPtr name, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr directory, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments(IntPtr arguments, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation(IntPtr iconPath, int maxPath, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassID(out Guid classId);
        [PreserveSig]
        int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    private struct PropVariant
    {
        [FieldOffset(0)]
        public ushort Type;
        [FieldOffset(8)]
        public IntPtr Pointer;
    }
}
