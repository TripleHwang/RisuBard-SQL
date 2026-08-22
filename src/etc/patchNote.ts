export const patchNote = {
    version: "0.8.3",
    content: 
`
# RisuBard 0.8.3
- 장기 채팅의 기억 정확도와 컨텍스트 효율을 개선했습니다.
  - 과거 사건의 원인이나 세부사항을 물으면 압축된 인물 정본뿐 아니라 관련 상세 사건 기록도 함께 참조합니다.
  - 정본 압축 과정에서 행동의 대상, 사건 순서, 인물별 지식과 관계가 바뀌지 않도록 기록 지침을 강화했습니다.
  - 일반적인 장면 진행에서는 이름이나 내용이 직접 관련되지 않고 링크로만 연결된 인물 문서를 컨텍스트에서 제외합니다. 인물·관계·과거·인과·연대기 질문에서는 연결 탐색을 유지합니다.
  - 최근 원문을 현재 장면의 기본 근거로 사용하고, 별도 현재 장면 문서는 있을 때만 참조합니다.
  - 기존 정본에 없는 지속적인 변화가 있을 때만 정본 재작성을 실행해 불필요한 분석 호출을 줄였습니다.
- 바드위키 보조 모델 호환성을 개선했습니다.
  - DeepSeek 네이티브 모델로 이야기와 작업 공간을 갱신할 때 구조화 JSON이 안정적으로 생성됩니다.
  - 일반 채팅과 다른 제공자 모델의 요청 방식은 변경하지 않습니다.
- 홈 화면에 PocketRisu 전체 통계가 RisuBard 이용 통계처럼 표시되던 항목과 외부 통계 호출을 제거했습니다.
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
