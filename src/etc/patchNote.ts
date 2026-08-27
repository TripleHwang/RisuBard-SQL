export const patchNote = {
    version: "0.1.0-beta.1",
    content: 
`
# RisuVault 0.1.0-beta.1
- Web과 standalone 서버에서 구조화 데이터를 SQLite 정본으로 저장합니다.
- 기존 Risu 데이터와 백업을 자동 이전하고 호환 형식으로 다시 내보낼 수 있습니다.
- PageFold 0.1.1을 기본 내장하여 메인 모델, 보조 모델, 플러그인 출력에서 선택할 수 있습니다.
- 첫 베타 버전이므로 중요한 데이터는 최신 백업과 함께 사용해 주세요.

## 포함된 RisuBard 0.8.11 변경사항
- 실제 모델 프리셋 요청과 화면에 표시되는 모델 이름이 일치하도록 수정했습니다.
- BardWiki 내부 요청이 현재 화면이 아닌 요청 대상 채팅의 모델 바인딩을 사용하도록 수정했습니다.
- 퍼스트 메시지 스튜디오의 별도 언어 행을 없애고 앱 언어를 기본으로 사용하도록 변경했습니다.
- 변수 이름 변경 시 선택지와 입력에 연결된 참조도 함께 갱신하도록 개선했습니다.
- 미리보기에서 편집 중인 단계와 입력 상태를 유지하고 초기화 버튼을 항상 사용할 수 있도록 개선했습니다.
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
