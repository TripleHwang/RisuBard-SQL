export const patchNote = {
    version: "0.8.10",
    content: 
`
# RisuBard 0.8.10
- 대화 처음부터 BardWiki를 다시 쌓는 중단·재개 가능한 위키 리부트를 추가했습니다.
- BardWiki 정본 갱신 호출과 장기 대화의 관련 문서 링크를 정리했습니다.
- 채팅 입력창에 앵커되는 드래그 가능한 세이브·로드 바로가기를 추가했습니다.
- 확인 창과 선택 창이 BardWiki 및 생성 통계보다 위에 표시되도록 수정했습니다.
- 범용 퍼스트 메시지 스튜디오 기반을 추가했습니다. 이 기능은 아직 개발 중입니다.
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
