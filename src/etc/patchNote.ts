export const patchNote = {
    version: "0.1.0-beta.1",
    content: 
`
# RisuVault 0.1.0-beta.1
- Web과 standalone 서버에서 구조화 데이터를 SQLite 정본으로 저장합니다.
- 기존 Risu 데이터와 백업을 자동 이전하고 호환 형식으로 다시 내보낼 수 있습니다.
- PageFold 0.1.1을 기본 내장하여 메인 모델, 보조 모델, 플러그인 출력에서 선택할 수 있습니다.
- 첫 베타 버전이므로 중요한 데이터는 최신 백업과 함께 사용해 주세요.
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
