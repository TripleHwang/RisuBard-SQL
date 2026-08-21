export const patchNote = {
    version: "0.8.3",
    content: 
`
# RisuBard 0.8.3
- 바드위키 보조 모델 호환성을 개선했습니다.
  - DeepSeek 네이티브 모델로 이야기와 작업 공간을 갱신할 때 구조화 JSON이 안정적으로 생성됩니다.
  - 일반 채팅과 다른 제공자 모델의 요청 방식은 변경하지 않습니다.
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
