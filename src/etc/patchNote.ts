export const patchNote = {
    version: "0.8.7",
    content: 
`
# RisuBard 0.8.7
- 프롬프트 프리셋, 모듈, 플러그인의 기본 목록에 폴더 정리 기능을 통합했습니다.
- 모듈을 페르소나별로 활성화할 수 있습니다.
- LLM 번역 캐시를 검색·편집·가져오기·내보내기·삭제할 수 있는 관리자를 추가했습니다.
- 플러그인 업데이트가 실제 설치와 저장 완료를 확인하고 성공 또는 실패를 안내하도록 수정했습니다.
- 여러 창에서 번역 캐시를 동시에 수정할 때 최신 값을 덮어쓰거나 삭제하지 않도록 충돌 감지를 추가했습니다.
- 대용량 로컬 백업 복원과 서버 요청 제한의 안정성을 개선했습니다.
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
