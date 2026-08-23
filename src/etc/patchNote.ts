export const patchNote = {
    version: "0.8.8",
    content: 
`
# RisuBard 0.8.8
- 자체 생성 정보 창을 제공하는 플러그인은 명시적인 오버라이드 옵션으로 RisuBard 요청 상태 창을 끌 수 있습니다.
- 기존 플러그인은 별도 설정 없이 RisuBard의 고급 요청 상태 창을 계속 사용합니다.
- BardWiki 도움말이 메모리 도크에 가리지 않고 화면 중앙의 최상위 창으로 표시됩니다.
- 플러그인 제작자를 위한 제공자 UI 호환성 문서를 추가했습니다.
`
}

export function getPatchNote(version: string){
    if(patchNote.version.split(".")[1] === version.split(".")[1] && patchNote.version.split(".")[0] === version.split(".")[0]){
        return patchNote
    }
return {
        version: version.split(".")[0] + "." + version.split(".")[1],
        content: ""
    }
}
