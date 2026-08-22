export const patchNote = {
    version: "0.8.5",
    content: 
`
# RisuBard 0.8.5
- Ollama Cloud의 GLM 등 보조 모델을 사용할 때 BardWiki 구조화 분석의 필수 항목이 누락되어 위키 갱신이 실패하던 문제를 수정했습니다.
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
