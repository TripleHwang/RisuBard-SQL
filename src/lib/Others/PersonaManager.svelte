<script lang="ts">
    import { XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { openPersonaManager } from 'src/ts/stores.svelte'
    import PersonaSettings from '../Setting/Pages/PersonaSettings.svelte'

    function close() {
        openPersonaManager.set(false)
    }
</script>

<div class="persona-manager-backdrop">
    <dialog open class="persona-manager" aria-labelledby="persona-manager-title">
        <header>
            <div>
                <span>{language.settingsWorkspace.personaManager.eyebrow}</span>
                <h1 id="persona-manager-title">{language.persona}</h1>
            </div>
            <button aria-label={language.settingsWorkspace.personaManager.close} onclick={close}>
                <XIcon size={20} />
            </button>
        </header>
        <div class="persona-manager-content">
            <PersonaSettings embedded />
        </div>
    </dialog>
</div>

<style>
    .persona-manager-backdrop {
        position: fixed;
        inset: 0;
        z-index: 40;
        display: flex;
        justify-content: flex-start;
        padding: 1rem;
        background: color-mix(in srgb, #000 42%, transparent);
        backdrop-filter: blur(5px);
    }

    .persona-manager {
        margin: 0;
        width: min(42rem, calc(100vw - 2rem));
        height: calc(100dvh - 2rem);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        color: var(--risu-theme-textcolor);
        background: var(--risu-theme-bgcolor);
        border: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 78%, transparent);
        border-radius: 1rem;
        box-shadow: 0 24px 80px rgb(0 0 0 / .28);
    }

    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1.35rem 1.5rem 1rem;
        border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 68%, transparent);
    }

    header span {
        color: var(--risu-theme-textcolor2);
        font-size: .66rem;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
    }

    header h1 {
        margin: .2rem 0 0;
        font-size: 1.35rem;
        font-weight: 700;
    }

    header button {
        width: 2.35rem;
        height: 2.35rem;
        display: grid;
        place-items: center;
        border-radius: .6rem;
        color: var(--risu-theme-textcolor2);
    }

    header button:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 65%, transparent);
    }

    .persona-manager-content {
        flex: 1;
        overflow-y: auto;
        padding: 1.5rem;
    }

    @media (max-width: 600px) {
        .persona-manager-backdrop {
            padding: 0;
        }

        .persona-manager {
            width: 100%;
            height: 100dvh;
            border: 0;
            border-radius: 0;
        }
    }
</style>
