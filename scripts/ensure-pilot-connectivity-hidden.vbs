Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""E:\GestaoLogistica_DEV\scripts\ensure-pilot-connectivity.ps1"""
shell.Run command, 0, False
