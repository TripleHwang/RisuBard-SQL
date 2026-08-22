<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import ModuleMenu from "src/lib/Setting/Pages/Module/ModuleMenu.svelte";
    import { exportModule, importModule, refreshModules, type RisuModule } from "src/ts/process/modules";
    import { SquarePen, TrashIcon, Globe, Share2Icon, PlusIcon, HardDriveUpload, Waypoints, FolderOpenIcon, UsersRoundIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { tooltip } from "src/ts/gui/tooltip";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { onDestroy } from "svelte";
    import { importMCPModule } from "src/ts/process/mcp/mcp";
    import { convertModuleToCharacter } from "src/ts/interchangeability";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import CollectionOrganizerDialog from "src/lib/UI/CollectionOrganizerDialog.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import { normalizePersonaEnabledModules } from "src/ts/storage/database.svelte";
    let tempModule:RisuModule = $state({
        name: '',
        description: '',
        id: v4(),
    })
    let mode = $state(0)
    let editModuleIndex = $state(-1)
    let moduleSearch = $state('')
    let organizerOpen = $state(false)
    let personaAssignmentOpen = $state(false)
    let personaAssignmentModuleId = $state('')
    let personaSearch = $state('')
    const organizerModuleItems = $derived(DBState.db.modules.map((module) => ({
        id: module.id,
        title: module.name,
        detail: module.description,
    })))

    function sortModules(modules:RisuModule[], search:string){
        return modules.filter((v) => {
            if(search === '') return true
            return v.name.toLowerCase().includes(search.toLowerCase())
        
        }).sort((a, b) => {
            let score = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            return score
        })
    }

    function personaOptions(){
        const options:{ id:string, name:string, scope:string }[] = []
        const seen = new Set<string>()
        for(const persona of DBState.db.personas){
            if(!persona.id || seen.has(persona.id)) continue
            seen.add(persona.id)
            options.push({ id: persona.id, name: persona.name, scope: language.globalPersonaScope })
        }
        for(const character of DBState.db.characters){
            for(const persona of character.personas ?? []){
                if(!persona.id || seen.has(persona.id)) continue
                seen.add(persona.id)
                options.push({ id: persona.id, name: persona.name, scope: `${language.character}: ${character.name}` })
            }
        }
        return options
    }

    function normalizeAssignments(){
        DBState.db.personaEnabledModules = normalizePersonaEnabledModules(
            DBState.db.personaEnabledModules,
            [
                ...DBState.db.personas,
                ...DBState.db.characters.flatMap((character) => character.personas ?? []),
            ],
            DBState.db.modules.map((module) => module.id),
        )
    }

    function openPersonaAssignments(moduleId:string){
        normalizeAssignments()
        personaAssignmentModuleId = moduleId
        personaSearch = ''
        personaAssignmentOpen = true
    }

    function personaAssignmentCount(moduleId:string){
        const validPersonaIds = new Set(personaOptions().map((persona) => persona.id))
        return Object.entries(DBState.db.personaEnabledModules ?? {})
            .filter(([personaId, moduleIds]) => validPersonaIds.has(personaId) && moduleIds.includes(moduleId))
            .length
    }

    function isAssignedToPersona(personaId:string){
        return DBState.db.personaEnabledModules?.[personaId]?.includes(personaAssignmentModuleId) ?? false
    }

    function togglePersonaAssignment(personaId:string){
        const assignments = { ...(DBState.db.personaEnabledModules ?? {}) }
        const moduleIds = [...(assignments[personaId] ?? [])]
        const index = moduleIds.indexOf(personaAssignmentModuleId)
        if(index >= 0) moduleIds.splice(index, 1)
        else moduleIds.push(personaAssignmentModuleId)
        if(moduleIds.length > 0) assignments[personaId] = moduleIds
        else delete assignments[personaId]
        DBState.db.personaEnabledModules = assignments
        normalizeAssignments()
    }

    function filteredPersonaOptions(){
        const search = personaSearch.trim().toLocaleLowerCase()
        if(!search) return personaOptions()
        return personaOptions().filter((persona) =>
            persona.name.toLocaleLowerCase().includes(search)
            || persona.scope.toLocaleLowerCase().includes(search)
        )
    }

    function assignmentModuleName(){
        return DBState.db.modules.find((module) => module.id === personaAssignmentModuleId)?.name ?? ''
    }

    onDestroy(() => {
        refreshModules()
    })
</script>
{#if mode === 0}
    <SettingPage title={language.modules}>

    <div class="mt-4 flex flex-wrap gap-2 items-center">
        <TextInput className="grow" placeholder={language.search} bind:value={moduleSearch} />
        <Button size="sm" onclick={() => { organizerOpen = true }}>
            <FolderOpenIcon size={16}/>{language.collectionOrganizer.open}
        </Button>
        <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={async () => {
            tempModule = {
                name: '',
                description: '',
                id: v4(),
            }
            mode = 1
        }}>
            <PlusIcon />
        </button>
        <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={async () => {
            importMCPModule()
        }}>
            <Waypoints />
        </button>
        <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={async () => {
            importModule()
        }}>
            <HardDriveUpload  />
        </button>
    </div>

    <div class="contain w-full max-w-full mt-4 flex flex-col border-selected border-1 rounded-md flex-1 overflow-y-auto">
        {#if DBState.db.modules.length === 0}
            <div class="text-textcolor2 p-3">{language.noModules}</div>
        {:else}
            {#each sortModules(DBState.db.modules, moduleSearch) as rmodule, i}
                {#if i !== 0}
                    <div class="border-t-1 border-selected"></div>
                {/if}

                <div class="pl-3 pt-3 text-left flex items-center">
                    {#if rmodule.mcp}
                        <Waypoints size={18} class="mr-2" />
                    {/if}
                    <span class="font-bold">{rmodule.name}</span>
                    <div class="grow flex justify-end">
                        <button class={(DBState.db.enabledModules.includes(rmodule.id)) ?
                                "mr-2 cursor-pointer text-blue-500" :
                                rmodule.namespace && 
                                DBState.db.moduleIntergration?.split(',').map((s) => s.trim()).includes(rmodule.namespace) ?
                                "text-amber-500 hover:text-primary mr-2 cursor-pointer" :
                                "text-textcolor2 hover:text-primary mr-2 cursor-pointer"
                            } use:tooltip={language.enableGlobal} onclick={async (e) => {
                            e.stopPropagation()
                            if(DBState.db.enabledModules.includes(rmodule.id)){
                                DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                            }
                            else{
                                DBState.db.enabledModules.push(rmodule.id)
                            }
                            DBState.db.enabledModules = DBState.db.enabledModules
                        }}>
                            <Globe size={18}/>
                        </button>
                        <button
                            class="text-textcolor2 hover:text-primary mr-2 cursor-pointer inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-borderc/50"
                            aria-label={language.managePersonaModules}
                            use:tooltip={language.managePersonaModules}
                            onclick={(e) => {
                                e.stopPropagation()
                                openPersonaAssignments(rmodule.id)
                            }}
                        >
                            <UsersRoundIcon size={18}/>
                            <span class="min-w-4 rounded-full bg-selected px-1 text-center text-xs text-textcolor">
                                {personaAssignmentCount(rmodule.id)}
                            </span>
                        </button>
                        {#if !rmodule.mcp}
                            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" use:tooltip={language.download} onclick={async (e) => {
                                e.stopPropagation()
                                exportModule(rmodule)
                            }}>
                                <Share2Icon size={18}/>
                            </button>
                            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" use:tooltip={language.edit} onclick={async (e) => {
                                e.stopPropagation()
                                const index = DBState.db.modules.findIndex((v) => v.id === rmodule.id)
                                tempModule = rmodule
                                editModuleIndex = index
                                mode = 2
                            }}>
                                <SquarePen size={18}/>
                            </button>
                        {:else}
                            <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                <Share2Icon size={18}/>
                            </button>
                            <button class="text-textcolor2 mr-2 cursor-not-allowed">
                                <SquarePen size={18}/>
                            </button>
                        {/if}
                        <button class="text-textcolor2 hover:text-red-400 mr-2 cursor-pointer" use:tooltip={language.remove} onclick={async (e) => {
                            e.stopPropagation()
                            const d = await alertConfirm(`${language.removeConfirm}` + rmodule.name)
                            if(d){
                                if(DBState.db.enabledModules.includes(rmodule.id)){
                                    DBState.db.enabledModules.splice(DBState.db.enabledModules.indexOf(rmodule.id), 1)
                                    DBState.db.enabledModules = DBState.db.enabledModules
                                }
                                const index = DBState.db.modules.findIndex((v) => v.id === rmodule.id)
                                DBState.db.modules.splice(index, 1)
                                DBState.db.modules = DBState.db.modules
                                normalizeAssignments()
                                notifySuccess(language.moduleDeleted)
                            }
                        }}>
                            <TrashIcon size={18}/>
                        </button>
                    </div>
                </div>
                <div class="mt-1 mb-3 pl-3">
                    <span class="text-sm text-textcolor2">{rmodule.description || 'No description provided'}</span>
                </div>
            {/each}
        {/if}
    </div>

    </SettingPage>
{:else if mode === 1}
    <SettingPage title={language.createModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    <Button className="mt-6" onclick={() => {
        DBState.db.modules.push(tempModule)
        notifySuccess(language.moduleCreated)
        mode = 0
    }}>{language.createModule}</Button>
    </SettingPage>
{:else if mode === 2}
    <SettingPage title={language.editModule}>
    <ModuleMenu bind:currentModule={tempModule}/>
    {#if tempModule.name !== ''}
        <Button className="mt-6" onclick={() => {
            DBState.db.modules[editModuleIndex] = tempModule
            notifySuccess(language.moduleUpdated)
            mode = 0
        }}>{language.editModule}</Button>
        <Button className="mt-2" onclick={() => {
            const char = convertModuleToCharacter(tempModule)
            DBState.db.characters.push(char)
            checkCharOrder()
            notifySuccess(language.successfullyConverted)
        }}>{language.convertToCharacter}</Button>
    {/if}
    </SettingPage>
{/if}

<CollectionOrganizerDialog
    bind:open={organizerOpen}
    kind="modules"
    items={organizerModuleItems}
    collectionLabel={language.modules}
/>

<ShDialog
    bind:open={personaAssignmentOpen}
    size="lg"
    tier="base"
    closeOnEscape={true}
    closeOnOutsideClick={true}
    ariaLabel={language.personaModuleAssignments}
>
    {#snippet title()}{language.personaModuleAssignments}: {assignmentModuleName()}{/snippet}
    {#snippet description()}{language.personaModuleAssignmentsDescription}{/snippet}

    <div class="flex flex-col gap-3">
        <label for="persona-module-search" class="sr-only">{language.searchPersonas}</label>
        <TextInput
            id="persona-module-search"
            fullwidth={true}
            placeholder={language.searchPersonas}
            bind:value={personaSearch}
        />
        {#if filteredPersonaOptions().length === 0}
            <p class="py-4 text-center text-sm text-textcolor2">{language.noPersonasFound}</p>
        {:else}
            <div class="max-h-[55vh] overflow-y-auto rounded-md border border-darkborderc divide-y divide-darkborderc">
                {#each filteredPersonaOptions() as persona (persona.id)}
                    <label class="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-selected/30 focus-within:bg-selected/30">
                        <input
                            type="checkbox"
                            class="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-borderc/50"
                            checked={isAssignedToPersona(persona.id)}
                            onchange={() => togglePersonaAssignment(persona.id)}
                        />
                        <span class="min-w-0 grow">
                            <span class="block truncate text-sm font-medium text-textcolor">{persona.name}</span>
                            <span class="block truncate text-xs text-textcolor2">{persona.scope}</span>
                        </span>
                    </label>
                {/each}
            </div>
        {/if}
    </div>
</ShDialog>
