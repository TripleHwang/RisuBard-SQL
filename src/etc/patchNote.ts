export const patchNote = {
    version: "0.8.6",
    content: 
`
# RisuBard 0.8.6
- 서버측 요청 기능을 사용할 때 BardWiki 내부 분석 결과 JSON이 다음 턴의 채팅 메시지로 노출될 수 있던 문제를 수정했습니다.
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
