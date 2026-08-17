const { spawn: defaultSpawn } = require('child_process')

function openServerBrowser(url, options = {}) {
    const platform = options.platform || process.platform
    const spawn = options.spawn || defaultSpawn
    let command
    let args
    if (platform === 'win32') {
        command = 'cmd.exe'
        args = ['/d', '/c', 'start', '', url]
    }
    else if (platform === 'darwin') {
        command = 'open'
        args = [url]
    }
    else {
        command = 'xdg-open'
        args = [url]
    }
    try {
        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        })
        child.once?.('error', () => undefined)
        child.unref()
        return true
    }
    catch {
        return false
    }
}

module.exports = {
    openServerBrowser,
}
