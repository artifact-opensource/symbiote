$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Dir 'symbiote.ps1')
