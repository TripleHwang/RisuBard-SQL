const { spawn: defaultSpawn } = require('child_process')
const { dirname, isAbsolute, win32 } = require('path')

function revealLocalFile(file, options = {}) {
    const platform = options.platform || process.platform
    const spawnImpl = options.spawnImpl || defaultSpawn
    const absolute = platform === 'win32'
        ? win32.isAbsolute(file)
        : isAbsolute(file)
    if (!absolute) throw new Error('Wiki file path must be absolute')

    let command
    let args
    if (platform === 'win32') {
        command = 'explorer.exe'
        args = ['/select,', file]
    }
    else if (platform === 'darwin') {
        command = 'open'
        args = ['-R', file]
    }
    else {
        command = 'xdg-open'
        args = [dirname(file)]
    }
    const child = spawnImpl(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    })
    child.unref()
}

module.exports = { revealLocalFile }
