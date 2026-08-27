<script lang="ts">
    interface Props {
        id: string;
        label: string;
        value: string;
        allowCss?: boolean;
        onChange: (value: string) => void;
        [key: `data-${string}`]: string | undefined;
    }
    let { id, label, value, allowCss = false, onChange, ...attributes }: Props = $props();
    const hex = $derived(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value ?? '')
        ? (value.length < 6 ? [...value.slice(1)].map((digit) => digit + digit).join('') : value.slice(1)) : null);

    function editRaw(event: Event, resetInvalid = false) {
        const input = event.currentTarget as HTMLInputElement;
        const next = input.value.trim();
        if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(next)
            || (allowCss && CSS.supports('color', next))) {
            if (next !== value) onChange(next);
        } else if (resetInvalid) input.value = value;
    }
</script>

<div class="flex items-center gap-2">
    {#if hex}
        <input {...attributes} type="color" aria-label={label} class="h-8 w-9 cursor-pointer rounded border border-darkborderc bg-transparent"
            value={`#${hex.slice(0, 6)}`} oninput={(event) => onChange(event.currentTarget.value + hex.slice(6))} />
    {:else}
        <span class="h-8 w-9 rounded border border-darkborderc" style:background-color={value} aria-hidden="true"></span>
    {/if}
    <input {id} type="text" value={value ?? ''} spellcheck="false" autocomplete="off"
        class="h-8 w-24 rounded border border-darkborderc bg-darkbg px-2 font-mono text-xs text-textcolor"
        oninput={(event) => editRaw(event)} onchange={(event) => editRaw(event, true)} />
</div>
