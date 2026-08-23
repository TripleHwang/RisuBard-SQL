export const patchNote = {
    version: "0.8.9",
    content: 
`
# RisuBard 0.8.9
- BardWiki가 보조 모델 프리셋의 추론 강도를 그대로 사용하도록 수정했습니다.
- 구조화된 BardWiki 요청이 추론 강도를 임의로 minimal로 낮추지 않습니다.
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
