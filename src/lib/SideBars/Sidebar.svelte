<script lang="ts">
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    OpenRealmStore,
    PlaygroundStore,

    QuickSettings,

    additionalHamburgerMenu,

    leftBarCollapsed,
    openPersonaManager,
    characterVaultOpen,
    CharConfigSubMenu,
    startupHydrationStore,
    startupHydrationErrorStore


  } from "../../ts/stores.svelte";
    import { setDatabase } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "./BarIcon.svelte";
    import SidebarIndicator from "./SidebarIndicator.svelte";
    import {
    ShellIcon,
    Settings,
    ListIcon,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    HomeIcon,
    User2Icon,
    ChevronsLeft,
    ArrowRight,
  } from "@lucide/svelte";
    import {
  addCharacter,
    changeChar,
    getCharImage,
  } from "../../ts/characters";
    import CharConfig from "./CharConfig.svelte";
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import ShSwitch from "../UI/GUI/ShSwitch.svelte";
    import { getCharacterIndexObject, makeAgoText, selectSingleFile } from "src/ts/util";
    import { checkCharOrder, getFileSrc, requestImmediateSave, saveAsset } from "src/ts/globalApi.svelte";
    import { alertInput, alertSelect } from "src/ts/alert";
    import SideChatList from "./SideChatList.svelte";

  import { sideBarSize } from "src/ts/gui/guisize";
  import DevTool from "./DevTool.svelte";
    import QuickSettingsGui from "../Others/QuickSettingsGUI.svelte";
  import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
  import CharacterVaultDialog from "./CharacterVaultDialog.svelte";
  import ShButton from "../UI/GUI/ShButton.svelte";
  import ShDialog from "../UI/GUI/ShDialog.svelte";
  import SolarBoldIcon from '../UI/Icons/SolarBoldIcon.svelte';
  import SolarAssetIcon from '../UI/Icons/SolarAssetIcon.svelte';
  import shareIcon from 'src/assets/solar-bold/share-bold.svg';
  import magnifierBugIcon from 'src/assets/solar-bold/magnifier-bug-bold.svg';
  import characterVaultIdle from 'src/assets/character-vault/books1-idle.png';
  import characterVaultHover from 'src/assets/character-vault/books1-hover.gif';
  import { tooltip } from "src/ts/gui/tooltip";
  import {
    getCharacterVaultQuickAccess,
    isCharacterVaultNew,
    moveCharacterVaultSidebarCharacter,
    reorderCharacterVaultSidebarShortcuts,
  } from "src/ts/characterVault";
  import { getEffectivePersona } from "src/ts/personaScopes";
  const isTouchDevice = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const touchDragEnabled = $derived(isTouchDevice && !DBState.db.disableMobileDragDrop);
  import { RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";
  import { isStartupMutationReady, runStartupMutation } from "src/ts/startupReadiness";
  import DeferredStartupGate from '../Others/DeferredStartupGate.svelte';

  let sideBarMode = $state(0);
  let editMode = $state(false);
  let menuMode = $state(0);
  let devTool = $state(false)
  let characterManageOpen = $state(false)
  $effect(() => {
    if ($selectedCharID < 0) characterManageOpen = false
  })
  const effectivePersona = $derived.by(() => {
    const character = DBState.db.characters[$selectedCharID]
    return getEffectivePersona(DBState.db, character, character?.chats?.[character.chatPage])
  })

  function reseter() {
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  function selectCharacter(index: number) {
    void changeChar(index, { reseter });
  }

  type sortTypeNormal = { type:'normal',id:string,img: string, index: number, name:string, isNew:boolean }
  type sortType =  sortTypeNormal|{type:'folder',folder:sortTypeNormal[],id:string, name:string, color:string, img?:string}
  let charImages: sortType[] = $state([]);
  // Recently interacted characters for the home sidebar. Character-level
  // `lastInteraction` is already in memory (no chat hydration needed), so this
  // sort is cheap; the $derived is only read while on the home screen.
  let recentChars = $derived(
    DBState.db.characters
      .map((c, index) => ({ index, name: c.name, image: c.image, lastInteraction: c.lastInteraction ?? 0, trashTime: c.trashTime }))
      .filter((c) => !c.trashTime)
      .filter((c) => c.lastInteraction > 0)
      .sort((a, b) => b.lastInteraction - a.lastInteraction)
  );
  // Progressive reveal: render `recentVisible` items, "Load more" adds 10.
  // Avoids mounting hundreds of avatar components at once (no list virtualization).
  let recentVisible = $state(10);
  let IconRounded = $state(false)
  let openFolders:string[] = $state([])
  let currentDrag: DragData | null = $state(null)
  interface Props {
    openGrid?: any;
    hidden?: boolean;
  }

  let { openGrid = () => {}, hidden = false }: Props = $props();

  sideBarClosing.set(false)

  $effect(() => {
    let newCharImages: sortType[] = [];
    const idObject = getCharacterIndexObject()
    const folderById = new Map(DBState.db.characterOrder.flatMap((entry) =>
      typeof entry === 'string' ? [] : [[entry.id, entry] as const]
    ))
    for (const shortcut of getCharacterVaultQuickAccess(DBState.db)) {
      if(shortcut.kind === 'character'){
        const index = idObject[shortcut.id] ?? -1
        if(index !== -1){
          const cha = DBState.db.characters[index]
          newCharImages.push({
            img:cha.image ?? "",
            id: cha.chaId,
            index:index,
            type: "normal",
            name: cha.name,
            isNew: isCharacterVaultNew(DBState.db, cha.chaId)
          });
        }
      }
      else{
        const folder = folderById.get(shortcut.id)
        if (!folder) continue
        let folderCharImages: sortTypeNormal[] = []
        for(const id of folder.data){
          const index = idObject[id] ?? -1
          if(index !== -1){
            const cha = DBState.db.characters[index]
            folderCharImages.push({
              img:cha.image ?? "",
              id: cha.chaId,
              index:index,
              type: "normal",
              name: cha.name,
              isNew: isCharacterVaultNew(DBState.db, cha.chaId)
            });
          }
        }
        newCharImages.push({
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
          img: folder.imgFile,
        });
      }
    }
    if (!isEqual(charImages, newCharImages)) {
      charImages = newCharImages;
    }
    if(IconRounded !== DBState.db.roundIcons){
      IconRounded = DBState.db.roundIcons
    }
  })


  function getFolderIndex(id:string){
    for(let i=0;i<DBState.db.characterOrder.length;i++){
      const data = DBState.db.characterOrder[i]
      if(typeof(data) !== 'string' && data.id === id){
        return i
      }
    }
    return -1
  }

  function scrollToActiveCharacter() {
    const selectedId = $selectedCharID
    if (selectedId === -1) return
    
    const characterId = DBState.db.characters[selectedId]?.chaId
    if (!characterId) return
    
    let targetFolderId: string | null = null
    
    for (const item of charImages) {
      if (item.type === 'folder') {
        const foundChar = item.folder.find(c => 
          DBState.db.characters[c.index]?.chaId === characterId
        )
        if (foundChar) {
          targetFolderId = item.id
          break
        }
      }
    }
    
    if (targetFolderId && !openFolders.includes(targetFolderId)) {
      openFolders.push(targetFolderId)
      openFolders = openFolders
    }
    
    setTimeout(() => {
      const activeElement = document.querySelector(`[data-char-id="${characterId}"]`)
      if (activeElement) {
        activeElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        })
      }
    }, 100)
  }

  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handler = () => {
      scrollToActiveCharacter()
    }
    
    window.addEventListener('scrollToActiveCharacter', handler)
    
    return () => {
      window.removeEventListener('scrollToActiveCharacter', handler)
    }
  })


  type DragEv = DragEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }
  type DragData =
    | { kind:'character', id:string, folder?:string }
    | { kind:'folder', id:string }
  type DropData = { index:number, folder?:string }

  const moveSidebarItem = (source:DragData, target:DropData) => {
    if (!isStartupMutationReady()) return false
    let changed = false
    if(target.folder){
      if(source.kind !== 'character') return false
      changed = moveCharacterVaultSidebarCharacter(
        DBState.db,
        source.id,
        target.folder,
        target.index
      )
      if(changed && !openFolders.includes(target.folder)){
        openFolders.push(target.folder)
        openFolders = openFolders
      }
    }
    else if(source.kind === 'character' && source.folder){
      changed = moveCharacterVaultSidebarCharacter(
        DBState.db,
        source.id,
        null,
        target.index
      )
    }
    else{
      changed = reorderCharacterVaultSidebarShortcuts(
        DBState.db,
        { kind: source.kind, id: source.id },
        target.index
      )
    }
    if(changed){
      checkCharOrder()
      void requestImmediateSave()
    }
    return changed
  }

  const getWritableFolder = (id:string) => {
    return runStartupMutation(() => {
      const folderIndex = getFolderIndex(id)
      if (folderIndex === -1) return null
      const folder = DBState.db.characterOrder[folderIndex]
      return typeof folder === 'string' ? null : { folderIndex, folder }
    }) ?? null
  }

  const avatarDragStart = (data:DragData, e:DragEv) => {
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.setData(RISU_SIDEBAR_DRAG_TYPE, 'true');
    currentDrag = data
    const avatar = e.currentTarget.querySelector('.avatar')
    if(avatar){
      e.dataTransfer.setDragImage(avatar, 10, 10);
    }
  }

  const clearCurrentDrag = () => {
    currentDrag = null
  }

  $effect(() => {
    if (typeof window === 'undefined') return

    window.addEventListener('dragend', clearCurrentDrag)
    window.addEventListener('drop', clearCurrentDrag)
    window.addEventListener('blur', clearCurrentDrag)

    return () => {
      window.removeEventListener('dragend', clearCurrentDrag)
      window.removeEventListener('drop', clearCurrentDrag)
      window.removeEventListener('blur', clearCurrentDrag)
    }
  })

  const getCurrentSidebarDrag = (e:DragEvent) => {
    if(!currentDrag || !e.dataTransfer?.types.includes(RISU_SIDEBAR_DRAG_TYPE)){
      return null
    }
    return currentDrag
  }

  const avatarDragOver = (e:DragEv) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  const avatarDrop = (target:DropData, e:DragEv) => {
    const drag = getCurrentSidebarDrag(e)
    if(!drag){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    try {
      moveSidebarItem(drag,target)
    } catch (error) {
      console.error('avatarDrop error:', error)
    } finally {
      clearCurrentDrag()
    }
  }

  const preventAll = (e:DragEvent) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    return false
  }

  // Touch long-press drag for mobile devices
  let touchDragState: {
    data: DragData
    element: HTMLElement
    ghost: HTMLElement | null
    highlighted: HTMLElement | null
  } | null = null
  let touchDragTimer = 0
  let touchStartPos = { x: 0, y: 0 }
  let suppressNextClick = false

  function onTouchDragStart(data: DragData, e: TouchEvent & { currentTarget: HTMLElement }) {
    const touch = e.touches[0]
    touchStartPos = { x: touch.clientX, y: touch.clientY }
    const el = e.currentTarget

    if (touchDragTimer) clearTimeout(touchDragTimer)
    touchDragTimer = window.setTimeout(() => {
      touchDragState = { data, element: el, ghost: null, highlighted: null }
      el.style.opacity = '0.4'
      try { navigator.vibrate?.(30) } catch {}

      const rect = el.getBoundingClientRect()
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.style.cssText = `position:fixed;pointer-events:none;z-index:9999;opacity:0.7;width:${rect.width}px;left:${touch.clientX - rect.width / 2}px;top:${touch.clientY - rect.height / 2}px;`
      document.body.appendChild(ghost)
      touchDragState.ghost = ghost
    }, 400)
  }

  function onTouchDragMove(e: TouchEvent) {
    const touch = e.touches[0]

    if (!touchDragState) {
      const dx = Math.abs(touch.clientX - touchStartPos.x)
      const dy = Math.abs(touch.clientY - touchStartPos.y)
      if (dx > 8 || dy > 8) {
        if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
      }
      return
    }

    e.preventDefault()

    if (touchDragState.ghost) {
      const rect = touchDragState.element.getBoundingClientRect()
      touchDragState.ghost.style.left = `${touch.clientX - rect.width / 2}px`
      touchDragState.ghost.style.top = `${touch.clientY - rect.height / 2}px`
    }

    // Find drop target under finger
    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)
    if (touchDragState.ghost) touchDragState.ghost.style.display = ''

    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
      touchDragState.highlighted = null
    }

    if (!el) return
    const spacer = el.closest('[data-spacer-index]') as HTMLElement | null
    const item = el.closest('[data-drag-index]') as HTMLElement | null

    if (spacer) {
      spacer.classList.add('bg-green-500')
      touchDragState.highlighted = spacer
    } else if (item && item !== touchDragState.element) {
      item.classList.add('ring-2', 'ring-green-400')
      touchDragState.highlighted = item
    }
  }

  function cleanupTouchDrag() {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return false
    touchDragState.element.style.opacity = ''
    if (touchDragState.highlighted) {
      touchDragState.highlighted.classList.remove('bg-green-500', 'ring-2', 'ring-green-400')
    }
    if (touchDragState.ghost) touchDragState.ghost.remove()
    touchDragState = null
    return true
  }

  function onTouchDragEnd(e: TouchEvent) {
    if (touchDragTimer) { clearTimeout(touchDragTimer); touchDragTimer = 0 }
    if (!touchDragState) return

    const touch = e.changedTouches[0]

    if (touchDragState.ghost) touchDragState.ghost.style.display = 'none'
    const el = document.elementFromPoint(touch.clientX, touch.clientY)

    const spacer = el?.closest('[data-spacer-index]') as HTMLElement | null
    const item = el?.closest('[data-drag-index]') as HTMLElement | null

    if (spacer) {
      const idx = parseInt(spacer.dataset.spacerIndex!)
      const folder = spacer.dataset.spacerFolder || undefined
      moveSidebarItem(touchDragState.data, { index: idx, folder })
    } else if (item && item !== touchDragState.element) {
      const idx = parseInt(item.dataset.dragIndex!)
      const folder = item.dataset.dragFolder || undefined
      if(item.dataset.dragKind === 'folder'){
        moveSidebarItem(touchDragState.data, {
          index: parseInt(item.dataset.folderLength ?? '0'),
          folder: item.dataset.dragId,
        })
      }
      else{
        moveSidebarItem(touchDragState.data, { index: idx, folder })
      }
    }

    cleanupTouchDrag()
    suppressNextClick = true
    requestAnimationFrame(() => { suppressNextClick = false })
  }

  function onTouchDragCancel() {
    cleanupTouchDrag()
  }

  function touchDragContainer(node: HTMLElement) {
    node.addEventListener('touchmove', onTouchDragMove, { passive: false })
    node.addEventListener('touchend', onTouchDragEnd)
    node.addEventListener('touchcancel', onTouchDragCancel)
    return {
      destroy() {
        node.removeEventListener('touchmove', onTouchDragMove)
        node.removeEventListener('touchend', onTouchDragEnd)
        node.removeEventListener('touchcancel', onTouchDragCancel)
      }
    }
  }
</script>
{#if DBState.db.menuSideBar}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full mt-4"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore === 0 &&
    !$settingsOpen
  )}
  onclick={() => {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
  }}
>
  <HomeIcon />
  <span class="text-xs">{language.home}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!$settingsOpen}
  onclick={() => {
    if ($settingsOpen) {
      reseter();
      settingsOpen.set(false);
    } else {
      reseter();
      settingsOpen.set(true);
    }
  }}
>
  <Settings />
  <span class="text-xs">{language.settings}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID >= 0
  )}
  onclick={() => {
    reseter();
    openGrid();

  }}
>
  <User2Icon />
  <span class="text-xs">{language.character}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore !== 0
  )}
  onclick={() => {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(1)
  }}
>
  <ShellIcon />
  <span class="text-xs">{language.playground.playground}</span>
</button>
</div>
{:else}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:max-xs:hidden={$leftBarCollapsed}
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
  {#if !DBState.db.hamburgerButtonBottom}
  <button
    data-sidebar-options
    class="risu-button-lift mt-3 flex h-10 min-h-10 w-[52px] min-w-[52px] cursor-pointer items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary/80"
    class:max-xs:hidden={$leftBarCollapsed}
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <div data-sidebar-options-divider class="w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute w-20 min-w-20 flex border-b-selected border-b bg-bgcolor flex-col items-center pt-2 rounded-b-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          selectedCharID.set(-1)
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter()
          if($selectedCharID === -1 && $PlaygroundStore !== 0){
            PlaygroundStore.set(0)
            return
          }
          selectedCharID.set(-1)
          PlaygroundStore.set(1)
        }}
      ><ShellIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          openGrid();
        }}><LayoutGridIcon /></BarIcon
      >
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {/if}
  <div
    data-sidebar-persona
    class="mb-2 flex w-full flex-col items-center gap-1 border-b border-b-selected px-2 py-3"
    class:max-xs:hidden={$leftBarCollapsed}
  >
    <button
      class="group relative grid h-[54px] w-[54px] place-items-center overflow-hidden rounded-xl border border-borderc/25 bg-darkbg text-textcolor2 shadow-sm outline outline-4 outline-offset-0 outline-white transition-all hover:border-primary hover:text-primary"
      aria-label={language.persona}
      title={language.persona}
      onclick={() => openPersonaManager.set(true)}
    >
      {#if effectivePersona?.persona.icon}
        {#await getCharImage(effectivePersona.persona.icon, 'plain')}
          <User2Icon size={22} />
        {:then personaImage}
          <img src={personaImage} alt="" class="h-full w-full object-cover object-top" />
        {/await}
      {:else}
        <User2Icon size={22} />
      {/if}
      <span
        data-persona-scope-badge
        class="absolute right-0 top-0 grid size-5 place-items-center rounded-full border border-darkborderc bg-darkbg text-textcolor shadow-md"
        title={effectivePersona?.scope === 'character'
          ? language.settingsWorkspace.personaManager.characterTab
          : language.settingsWorkspace.personaManager.globalTab}
      >
        <SolarBoldIcon name={effectivePersona?.scope === 'character' ? 'people-nearby' : 'earth'} size={12} />
      </span>
      <span class="absolute inset-x-0 bottom-0 h-1 bg-primary opacity-80"></span>
    </button>
    <span class="w-full truncate text-center text-[10px] font-medium text-textcolor2">
      {effectivePersona?.persona.name || language.persona}
    </span>
  </div>
  <div
    data-character-vault-button
    class="flex w-full flex-col items-center gap-1 px-2 py-2"
    class:max-xs:hidden={$leftBarCollapsed}
  >
    <button
      type="button"
      class="character-toolbar-button character-toolbar-button--chat risu-button-lift group relative overflow-hidden p-0 outline outline-4 outline-offset-0 outline-black"
      style="width: 54px; height: 54px;"
      aria-label="Character Vault 열기"
      title="캐릭터 저장소 · 고정한 캐릭터만 사이드바에 표시됩니다."
      use:tooltip={"캐릭터 저장소 · 고정한 캐릭터만 사이드바에 표시됩니다."}
      disabled={$startupHydrationStore || $startupHydrationErrorStore}
      onclick={() => { if (isStartupMutationReady()) characterVaultOpen.set(true) }}
    >
      <img
        src={characterVaultIdle}
        alt=""
        draggable="false"
        class="size-full object-contain transition-opacity group-hover:opacity-0"
      />
      <img
        src={characterVaultHover}
        alt=""
        draggable="false"
        class="absolute inset-0 size-full object-contain opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
    <span data-character-vault-label class="text-[10px] font-medium leading-none text-textcolor2">저장소</span>
  </div>
  <div data-quick-inventory class="character-list flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto pr-0" class:max-xs:hidden={$leftBarCollapsed} use:touchDragContainer>
    <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index="0" ondragover={(e) => {
      if(!getCurrentSidebarDrag(e)){ return }
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      e.currentTarget.classList.add('bg-green-500')
    }} ondragleave={(e) => {
      e.currentTarget.classList.remove('bg-green-500')
    }} ondrop={(e) => {
      const drag = getCurrentSidebarDrag(e)
      if(!drag){ return }
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.classList.remove('bg-green-500')
      try {
        moveSidebarItem(drag,{index:0})
      } finally {
        clearCurrentDrag()
      }
    }} ondragenter={preventAll}></div>
    {#each charImages as char, ind}
      <div class="group relative flex items-center px-2"
        role="listitem"
        data-drag-index={ind}
        data-drag-kind={char.type === 'normal' ? 'character' : 'folder'}
        data-drag-id={char.id}
        data-folder-length={char.type === 'folder' ? char.folder.length : undefined}
        draggable={!isTouchDevice ? "true" : undefined}
        ondragstart={!isTouchDevice ? (e) => {avatarDragStart({ kind: char.type === 'normal' ? 'character' : 'folder', id: char.id }, e)} : undefined}
        ondragend={!isTouchDevice ? clearCurrentDrag : undefined}
        ondragover={!isTouchDevice ? avatarDragOver : undefined}
        ondrop={!isTouchDevice ? (e) => {avatarDrop(char.type === 'folder'
          ? {index:char.folder.length, folder:char.id}
          : {index:ind}, e)} : undefined}
        ondragenter={!isTouchDevice ? preventAll : undefined}
        ontouchstart={touchDragEnabled ? (e) => {onTouchDragStart({ kind: char.type === 'normal' ? 'character' : 'folder', id: char.id }, e)} : undefined}
      >
        <SidebarIndicator
          isActive={char.type === 'normal' && $selectedCharID === char.index && sideBarMode !== 1}
        />
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="relative"
            role="button" tabindex="0"
            onclick={() => {
              if(suppressNextClick) return
              if(char.type === "normal"){
                selectCharacter(char.index);
              }
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                if(char.type === "normal"){
                  selectCharacter(char.index);
                }
              }
            }}
          >
          {#if char.type === 'normal'}
            <SidebarAvatar 
              src={char.img ? getCharImage(char.img, "plain") : "/none.webp"} 
              size="56" 
              rounded={IconRounded} 
              name={char.name}
              chaId={DBState.db.characters[char.index]?.chaId}
            />
            {#if char.isNew}
              <span data-new-character-badge class="pointer-events-none absolute bottom-0 right-0 z-20 text-white" role="img" aria-label="새 캐릭터" title="새 캐릭터">
                <SolarBoldIcon name="star-shine" size={20} />
              </span>
            {/if}
          {:else if char.type === "folder"}
            {#key char.color}
            {#key char.name}
              <SidebarAvatar src="slot" size="56" rounded={IconRounded} bordered name={char.name} color={char.color} backgroundimg={char.img ? getCharImage(char.img, "plain") : ""}
              oncontextmenu={async (e) => {
                e.preventDefault()
                if (!isStartupMutationReady()) return
                const sel = parseInt(await alertSelect([language.renameFolder,language.changeFolderColor,language.changeFolderImage,language.cancel]))
                if(sel === 0){
                  const v = await alertInput(language.changeFolderName, [], char.name)
                  const target = getWritableFolder(char.id)
                  if(v && target){
                    target.folder.name = v
                    DBState.db.characterOrder[target.folderIndex] = target.folder
                  }
                }
                else if(sel === 1){
                  const colors = ["red","green","blue","yellow","indigo","purple","pink","default"]
                  const sel = parseInt(await alertSelect(colors))
                  const target = getWritableFolder(char.id)
                  if (!target) return
                  target.folder.color = colors[sel].toLocaleLowerCase()
                  DBState.db.characterOrder[target.folderIndex] = target.folder
                }
                else if(sel === 2) {
                  const sel = parseInt(await alertSelect(['Reset to Default Image', 'Select Image File']))

                  switch (sel) {
                    case 0:
                      const resetTarget = getWritableFolder(char.id)
                      if (!resetTarget) return
                      resetTarget.folder.imgFile = null
                      resetTarget.folder.img = ''
                      DBState.db.characterOrder[resetTarget.folderIndex] = resetTarget.folder
                      break;
                  
                    case 1:
                      const folderImage = await selectSingleFile([
                        'png',
                        'jpg',
                        'webp',
                      ])

                      if(!folderImage) {
                        return
                      }

                      if (!isStartupMutationReady()) return

                      const folderImageData = await saveAsset(folderImage.data)
                      const folderImageSrc = await getFileSrc(folderImageData)
                      const imageTarget = getWritableFolder(char.id)
                      if (!imageTarget) return
                      imageTarget.folder.imgFile = folderImageData
                      imageTarget.folder.img = folderImageSrc
                      DBState.db.characterOrder[imageTarget.folderIndex] = imageTarget.folder
                      break;
                  }
                }
              }}
              onClick={() => {
                if(suppressNextClick) return
                if(char.type !== 'folder'){
                  return
                }
                if(openFolders.includes(char.id)){
                  openFolders.splice(openFolders.indexOf(char.id), 1)
                }
                else{
                  openFolders.push(char.id)
                }
                openFolders = openFolders
              }}>
                {#if DBState.db.showFolderName}
                  <div class="h-full w-full flex justify-center items-center">
                    <span class="hyphens-auto truncate font-bold">{char.name}</span>
                  </div>
                {:else if openFolders.includes(char.id)}
                  <FolderOpenIcon />
                {:else}
                  <FolderIcon />
                {/if}
              </SidebarAvatar>
            {/key}
            {/key}
          {/if}
        </div>
      </div>
      {#if char.type === 'folder' && openFolders.includes(char.id)}
        {#key char.color}
        <div class="p-1 flex flex-col items-center py-1 mt-1 rounded-lg relative">
          <div class="absolute top-0 left-1 border border-selected w-full h-full rounded-lg z-0 {
            char.color === 'red' ? 'bg-red-700/20' :
            char.color === 'yellow' ? 'bg-yellow-700/20' :
            char.color === 'green' ? 'bg-green-700/20' :
            char.color === 'blue' ? 'bg-blue-700/20' :
            char.color === 'indigo' ? 'bg-indigo-700/20' :
            char.color === 'purple' ? 'bg-purple-700/20' :
            char.color === 'pink' ? 'bg-pink-700/20' :
            'bg-darkbg/20'
          }" style:background-color={char.color.startsWith('#')
            ? `color-mix(in srgb, ${char.color} 20%, transparent)`
            : undefined}></div>
          <div class="h-4 min-h-4 w-14 relative z-10" role="listitem" data-spacer-index="0" data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
            if(!getCurrentSidebarDrag(e)){ return }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            e.currentTarget.classList.add('bg-green-500')
          }} ondragleave={(e) => {
            e.currentTarget.classList.remove('bg-green-500')
          }} ondrop={(e) => {
            const drag = getCurrentSidebarDrag(e)
            if(!drag){ return }
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.classList.remove('bg-green-500')
            try {
              if(char.type === 'folder'){
                moveSidebarItem(drag,{index:0,folder:char.id})
              }
            } finally {
              clearCurrentDrag()
            }
          }} ondragenter={preventAll}></div>
          {#each char.folder as char2, ind}
              <div class="group relative flex items-center px-2 z-10"
              role="listitem"
              data-drag-index={ind}
              data-drag-folder={char.type === 'folder' ? char.id : undefined}
              data-drag-kind="character"
              data-drag-id={char2.id}
              draggable={!isTouchDevice ? "true" : undefined}
              ondragstart={!isTouchDevice ? (e) => {avatarDragStart({ kind:'character', id:char2.id, folder:char.id }, e)} : undefined}
              ondragend={!isTouchDevice ? clearCurrentDrag : undefined}
              ondragover={!isTouchDevice ? avatarDragOver : undefined}
              ondrop={!isTouchDevice ? (e) => {avatarDrop({index: ind, folder:char.id}, e)} : undefined}
              ondragenter={!isTouchDevice ? preventAll : undefined}
              ontouchstart={touchDragEnabled ? (e) => {onTouchDragStart({ kind:'character', id:char2.id, folder:char.id }, e)} : undefined}
            >
              <SidebarIndicator
                isActive={$selectedCharID === char2.index && sideBarMode !== 1}
              />
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div class="relative"
                  role="button" tabindex="0"
                  onclick={() => {
                    if(suppressNextClick) return
                    if(char2.type === "normal"){
                      selectCharacter(char2.index);
                    }
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      if(char2.type === "normal"){
                        selectCharacter(char2.index);
                      }
                    }
                  }}
                >
                <SidebarAvatar 
                  src={char2.img ? getCharImage(char2.img, "plain") : "/none.webp"} 
                  size="56" 
                  rounded={IconRounded} 
                  name={char2.name}
                  chaId={DBState.db.characters[char2.index]?.chaId}
                />
                {#if char2.isNew}
                  <span data-new-character-badge class="pointer-events-none absolute bottom-0 right-0 z-20 text-white" role="img" aria-label="새 캐릭터" title="새 캐릭터">
                    <SolarBoldIcon name="star-shine" size={20} />
                  </span>
                {/if}
              </div>
            </div>
            <div class="h-4 min-h-4 w-14 relative z-20" role="listitem" data-spacer-index={ind+1} data-spacer-folder={char.type === 'folder' ? char.id : undefined} ondragover={(e) => {
              if(!getCurrentSidebarDrag(e)){ return }
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              e.currentTarget.classList.add('bg-green-500')
            }} ondragleave={(e) => {
              e.currentTarget.classList.remove('bg-green-500')
            }} ondrop={(e) => {
              const drag = getCurrentSidebarDrag(e)
              if(!drag){ return }
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.classList.remove('bg-green-500')
              try {
                if(char.type === 'folder'){
                  moveSidebarItem(drag,{index:ind+1,folder:char.id})
                }
              } finally {
                clearCurrentDrag()
              }
            }} ondragenter={preventAll}></div>
          {/each}
        </div>
        {/key}
      {/if}
      <div class="h-4 min-h-4 w-14" role="listitem" data-spacer-index={ind+1} ondragover={((e) => {
        if(!getCurrentSidebarDrag(e)){ return }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        e.currentTarget.classList.add('bg-green-500')
      })} ondragleave={(e) => {
        e.currentTarget.classList.remove('bg-green-500')
      }} ondrop={(e) => {
        const drag = getCurrentSidebarDrag(e)
        if(!drag){ return }
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.classList.remove('bg-green-500')
        try {
          moveSidebarItem(drag,{index:ind+1})
        } finally {
          clearCurrentDrag()
        }
      }} ondragenter={preventAll}></div>
    {/each}
    <div class="flex flex-col items-center gap-2 px-2">
      <button
        type="button"
        data-sidebar-new-character
        class="flex h-14 w-14 cursor-pointer select-none items-center justify-center rounded-md border border-textcolor2 text-gray-300 transition-colors hover:border-gray-300"
        aria-label="새 캐릭터"
        title="새 캐릭터"
        use:tooltip={"새 캐릭터"}
        disabled={$startupHydrationStore || $startupHydrationErrorStore}
        onclick={async () => {
          addCharacter({reseter}) 
        }}
        ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
          ><path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          /></svg
        ></button
      >
    </div>
  </div>
  {#if DBState.db.hamburgerButtonBottom}
  <div class="border-t border-t-selected w-full relative text-white" class:max-xs:hidden={$leftBarCollapsed}>
    {#if menuMode === 1}
      <div class="absolute bottom-full w-20 min-w-20 flex border-t-selected border-t bg-bgcolor flex-col items-center pt-2 rounded-t-md z-20 pb-2 max-h-[calc(100dvh-4rem)] overflow-x-hidden overflow-y-auto hamburger-menu">
        <BarIcon
        onClick={() => {
          if ($settingsOpen) {
            reseter();
            settingsOpen.set(false);
          } else {
            reseter();
            settingsOpen.set(true);
          }
        }}><Settings /></BarIcon
      >
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          selectedCharID.set(-1)
          PlaygroundStore.set(0)
          OpenRealmStore.set(false)
        }}><HomeIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter()
          if($selectedCharID === -1 && $PlaygroundStore !== 0){
            PlaygroundStore.set(0)
            return
          }
          selectedCharID.set(-1)
          PlaygroundStore.set(1)
        }}
      ><ShellIcon /></BarIcon>
      <div class="mt-2"></div>
      <BarIcon
        onClick={() => {
          reseter();
          openGrid();
        }}><LayoutGridIcon /></BarIcon
      >
      {#if additionalHamburgerMenu.length > 0}
        <div class="mt-2 h-px w-10 bg-selected shrink-0"></div>
        {#each additionalHamburgerMenu as menu}
          <div class="mt-2"></div>
          <BarIcon
            onClick={() => {
              reseter();
              menu.callback();
            }}>
              <PluginDefinedIcon ico={menu} />
            </BarIcon
          >
        {/each}
      {/if}
    </div>
    {/if}
  </div>
  {#if !DBState.db.hideLeftBarCollapseButton}
  <button
    class="hidden max-xs:flex h-8 min-h-8 w-14 min-w-14 cursor-pointer mt-2 items-center justify-center rounded-md border border-borderc text-textcolor transition-colors hover:border-primary hover:text-primary"
    aria-label="Collapse sidebar"
    onclick={() => leftBarCollapsed.set(true)}
  >
    <ChevronsLeft size={20} />
  </button>
  {/if}
  <button
    class="risu-button-lift my-2 flex size-10 min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-md bg-textcolor2 text-white transition-colors hover:bg-primary"
    class:max-xs:hidden={$leftBarCollapsed}
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {/if}
</div>
{/if}
<div
  class="setting-area h-full max-xs:relative flex-col overflow-y-auto overflow-x-hidden bg-darkbg pt-2 pb-6 text-textcolor max-h-full"
  class:risu-sidebar={!$sideBarClosing}
  class:w-96={$sideBarSize === 0}
  class:w-110={$sideBarSize === 1}
  class:w-124={$sideBarSize === 2}
  class:w-138={$sideBarSize === 3}
  class:risu-sidebar-close={$sideBarClosing}
  class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
  class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
  class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
  class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
  class:px-2={$DynamicGUI}
  class:px-4={!$DynamicGUI}
  class:dynamic-sidebar={$DynamicGUI}
  class:hidden={hidden}
  class:flex={!hidden}
  onanimationend={() => {
    if($sideBarClosing){
      $sideBarClosing = false
      sideBarStore.set(false)
    }
  }}
>
  <button
    class="flex w-full justify-end text-textcolor"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
  </button>
  {#if $leftBarCollapsed}
    <button
      class="hidden max-xs:flex absolute top-3 left-0 h-12 w-12 border-r border-b border-t border-borderc rounded-r-md bg-darkbg hover:border-neutral-200 transition-colors items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20"
      aria-label="Expand sidebar"
      onclick={() => leftBarCollapsed.set(false)}
    >
      <ArrowRight />
    </button>
  {/if}
  {#if sideBarMode === 0}
    {#if $selectedCharID < 0 || $settingsOpen}
      <span class="block text-base font-semibold text-textcolor mt-2">{language.recentChatsTitle}</span>
      <div class="flex items-center justify-between gap-2 mt-2">
        <span class="text-sm text-textcolor2">{language.hideRecentChats}</span>
        <ShSwitch
          checked={!!DBState.db.nodeOnlyHideRecentChats}
          onCheckedChange={(v) => (DBState.db.nodeOnlyHideRecentChats = v)}
        />
      </div>
      {#if DBState.db.nodeOnlyHideRecentChats}
        <!-- list hidden by user preference -->
      {:else if recentChars.length === 0}
        <span class="block text-sm text-textcolor2 mt-2">{language.noRecentChatsDesc}</span>
      {:else}
        <div class="flex flex-col gap-1.5 mt-2">
          {#each recentChars.slice(0, recentVisible) as rc (rc.index)}
            <button
              type="button"
              class="group flex items-center gap-2.5 rounded-md border border-borderc/10 bg-darkbg p-2 text-left transition-colors hover:border-borderc/30 hover:bg-selected/50"
              onclick={() => selectCharacter(rc.index)}
            >
              <div class="shrink-0">
                <SidebarAvatar
                  src={rc.image ? getCharImage(rc.image, "plain") : "/none.webp"}
                  size="36"
                  rounded={IconRounded}
                  name={rc.name}
                  chaId={DBState.db.characters[rc.index]?.chaId}
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-textcolor leading-tight truncate">{rc.name || "Unnamed"}</div>
                <div class="text-xs text-textcolor2 leading-tight truncate">{makeAgoText(rc.lastInteraction)}</div>
              </div>
            </button>
          {/each}
          {#if recentVisible < recentChars.length}
            <button
              type="button"
              class="w-full rounded-md border border-borderc/10 bg-darkbg p-2 text-center text-sm text-textcolor2 transition-colors hover:border-borderc/30 hover:bg-selected/50 hover:text-textcolor"
              onclick={() => recentVisible += 10}
            >
              {language.loadMore}
            </button>
          {/if}
        </div>
      {/if}
    {:else if DBState.db.characters[$selectedCharID]?.chaId === '§playground'}
      <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
    {:else}
      {@const currentCharacter = DBState.db.characters[$selectedCharID]}
      <div data-character-workspace-header class="flex min-h-10 items-center gap-2 border-b border-darkborderc pb-2">
        <strong data-character-title class="min-w-0 grow truncate text-base text-textcolor">
          {currentCharacter.name || language.character}
        </strong>
        {#if currentCharacter.type === 'character'}
          <ShButton
            data-character-manage
            variant="outline"
            size="icon-sm"
            aria-label={language.manageCharacter}
            title={language.manageCharacter}
            onclick={() => {
              characterManageOpen = true
            }}
          >
            <SolarAssetIcon src={shareIcon} name="share-bold" size={18} />
          </ShButton>
        {/if}
        {#if DBState.db.enableDevTools}
          <ShButton variant="ghost" size="icon-sm" aria-label="Developer tools" title="Developer tools" onclick={() => { devTool = true }}>
            <SolarAssetIcon src={magnifierBugIcon} name="magnifier-bug-bold" size={18} />
          </ShButton>
        {/if}
      </div>
      {#if currentCharacter.license !== 'private'}
        <nav data-character-config-navigation aria-label={language.character} class="my-2 flex w-full items-center justify-evenly gap-1 rounded-lg bg-selected/25 p-1">
          <button type="button" data-character-chat-home aria-label={language.Chat} aria-pressed={!$botMakerMode && !devTool} use:tooltip={language.Chat} class="character-toolbar-button character-toolbar-button--chat risu-button-lift" class:is-active={!$botMakerMode && !devTool} onclick={() => { devTool = false; botMakerMode.set(false) }}>
            <SolarBoldIcon name="chat-round-dots" size={22} />
          </button>
          <button type="button" data-character-config-tab aria-label={language.characterInfo} use:tooltip={language.characterInfo} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 0} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 0} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(0) }}>
            <SolarBoldIcon name="people-nearby" size={22} />
          </button>
          <button type="button" data-character-config-tab aria-label={language.characterDisplay} use:tooltip={language.characterDisplay} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 1} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 1} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(1) }}>
            <SolarBoldIcon name="gallery-wide" size={22} />
          </button>
          <button type="button" data-character-config-tab aria-label={language.loreBook} use:tooltip={language.loreBook} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 3} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 3} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(3) }}>
            <SolarBoldIcon name="notebook" size={22} />
          </button>
          {#if currentCharacter.type === 'character'}
            <button type="button" data-character-config-tab aria-label={"TTS"} use:tooltip={"TTS"} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 5} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 5} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(5) }}>
              <SolarBoldIcon name="microphone-3" size={22} />
            </button>
            <button type="button" data-character-config-tab aria-label={language.scripts} use:tooltip={language.scripts} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 4} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 4} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(4) }}>
              <SolarBoldIcon name="code-square" size={22} />
            </button>
          {/if}
          <button type="button" data-character-config-tab aria-label={language.advancedSettings} use:tooltip={language.advancedSettings} aria-pressed={$botMakerMode && !devTool && $CharConfigSubMenu === 2} class="character-toolbar-button risu-button-lift" class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 2} onclick={() => { devTool = false; botMakerMode.set(true); CharConfigSubMenu.set(2) }}>
            <SolarBoldIcon name="settings" size={22} />
          </button>
        </nav>
      {/if}
      {#if QuickSettings.open}
        <DeferredStartupGate><QuickSettingsGui /></DeferredStartupGate>
      {:else if devTool}
        <DevTool />
      {:else if $botMakerMode}
        <CharConfig />
      {:else}
        <SideChatList bind:chara={ DBState.db.characters[$selectedCharID]} />
      {/if}
    {/if}
  {/if}
</div>

{#if $DynamicGUI}
    <div role="button" tabindex="0" class="grow h-full min-w-12"
      class:max-xs:!min-w-8={!$leftBarCollapsed}
      class:max-xs:!min-w-6={$leftBarCollapsed}
      class:hidden={hidden} onclick={() => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
      onkeydown={(e)=>{
        if(e.key === 'Enter'){
            e.currentTarget.click()
        }
      }}
      class:sidebar-dark-animation={!$sideBarClosing}
      class:sidebar-dark-close-animation={$sideBarClosing}>

    </div>

{/if}

{#if $characterVaultOpen}
  <div class="relative">
    <DeferredStartupGate>
      <CharacterVaultDialog
        open={$characterVaultOpen}
        onOpenChange={(open) => { if (open && !isStartupMutationReady()) return; characterVaultOpen.set(open) }}
        onSelectCharacter={selectCharacter}
      />
    </DeferredStartupGate>
  </div>
{/if}

<ShDialog
  bind:open={characterManageOpen}
  onOpenChange={(open) => { characterManageOpen = open }}
  size="xl"
  tier="base"
  closeOnEscape={true}
  closeOnOutsideClick={true}
  ariaLabel={language.manageCharacter}
  closeAriaLabel={language.close}
  contentClass="bg-darkbg"
  bodyClass="min-h-0 overflow-y-auto pr-1"
>
  <CharConfig subMenuOverride={6} />
</ShDialog>

<style>
  .editMode {
    min-width: 6rem;
  }
  @keyframes sidebar-transition {
    from {
      width: 0rem;
    }
    to {
      width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close {
    from {
      width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-transition-non-dynamic {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close-non-dynamic {
    from {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      right:3rem;
    }
  }
  @keyframes sub-sidebar-transition {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: 5rem;
      min-width: 5rem;
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: 5rem;
      min-width: 5rem;
      max-width: 5rem;
      right:0rem;

    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-dark-animation{
    from {
      background-color: rgba(0,0,0,0) !important;
    }
    to {
      background-color: rgba(0,0,0,0.5) !important;
    }
  }
  @keyframes sidebar-dark-closing-animation{
    from {
      background-color: rgba(0,0,0,0.5) !important;
    }
    to {
      background-color: rgba(0,0,0,0) !important;
    }
  }

  .risu-sidebar:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-non-dynamic;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-close-non-dynamic;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .risu-sidebar.dynamic-sidebar {
    animation-name: sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close.dynamic-sidebar {
    animation-name: sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
    right: 3rem;
  }


  .risu-sub-sidebar {
    animation-name: sub-sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sub-sidebar-close {
    animation-name: sub-sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .sidebar-dark-animation{
    animation-name: sidebar-dark-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0.5)
  }
  .sidebar-dark-close-animation{
    animation-name: sidebar-dark-closing-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0)
  }
  .hamburger-menu {
    scrollbar-width: none;
    overscroll-behavior: none;
  }
  .hamburger-menu::-webkit-scrollbar {
    display: none;
  }
  .character-list {
    scrollbar-width: none;
  }
  .character-list::-webkit-scrollbar {
    display: none;
  }
  :global([data-new-character-badge] svg path) {
    fill: #fff;
    stroke: #000;
    stroke-width: 2px;
    stroke-linejoin: round;
    paint-order: stroke fill;
  }
</style>
