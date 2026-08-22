export const patchNote = {
    version: "0.8.4",
    content: 
`
# RisuBard 0.8.4
- BardWiki가 한국어 복합어와 간접 단서를 따라 관련 과거 사건을 더 정확하게 찾습니다.
- 새 기본 Wiki Prompt Preset에 퍼즐·단서 추적기와 퍼즐·관계 추론 응답 보조 블록을 추가했습니다.
- Wiki Prompt Preset 편집기를 위키 작성 블록과 응답 보조 블록으로 분리하고, 잠긴 계약 열람·복사와 프롬프팅 도움말을 추가했습니다.
- 메인 화면의 RisuRealm 브라우저를 최신 테마 UI로 개편하고 한국어 UI를 지원합니다.
- 검색 Enter 실행, 공백 단위 다중 태그 자동완성, 전체 태그 알파벳순 탐색과 키보드 선택을 지원합니다.
- 캐릭터 설명의 URL을 자동 링크화하고 상세 창의 텍스트 선택과 다운로드 동작을 개선했습니다.
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
