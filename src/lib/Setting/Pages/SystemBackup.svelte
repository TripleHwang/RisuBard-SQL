<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { DownloadIcon, UploadIcon, SettingsIcon } from '@lucide/svelte'
    import { alertConfirm } from 'src/ts/alert'
    import { language } from 'src/lang'
    import { LoadLocalBackup, SaveLocalBackup, SaveSettingsOnlyBackup } from 'src/ts/drive/backuplocal'

    async function downloadLocal() {
        if (!(await alertConfirm(language.backupConfirm))) return
        SaveLocalBackup()
    }

    function downloadSettingsOnly() {
        SaveSettingsOnlyBackup()
    }

    async function restoreFromLocalFile() {
        if (!(await alertConfirm(language.backupLoadConfirm))) return
        if (!(await alertConfirm(language.backupLoadConfirm2))) return
        LoadLocalBackup()
    }
</script>

<p class="text-textcolor2 text-sm mb-4">{language.backupTabDesc}</p>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center gap-2 text-textcolor mb-3">
        <DownloadIcon size={16} />
        <span class="font-medium">{language.backupLocal}</span>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.backupLocalDesc}</p>

    <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupLocalDownload}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalDownloadDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadLocal}>
                <DownloadIcon size={14} />
                {language.backupLocalDownload}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.backupSettingsOnly}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupSettingsOnlyDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={downloadSettingsOnly}>
                <SettingsIcon size={14} />
                {language.backupSettingsOnly}
            </ShButton>
        </div>
        <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50">
            <div class="flex flex-col min-w-0 flex-1">
                <span class="text-textcolor text-sm font-medium">{language.loadBackupLocal}</span>
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{language.backupLocalRestoreDesc}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={restoreFromLocalFile}>
                <UploadIcon size={14} />
                {language.loadBackupLocal}
            </ShButton>
        </div>
    </div>
</div>
