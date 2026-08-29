export const patchNote = {
    version: "0.3.4",
    content: 
`
# RisuVault 0.3.4
- 마이그레이션 조각을 statement 개수뿐 아니라 크기로도 나눕니다. 긴 한글 대화 기록에서 요청이 서버 제한을 넘어 실패하던 문제를 고쳤습니다.
- 레거시 데이터를 SQL로 옮기는 작업을 여러 요청으로 나눠 보냅니다. 약 35 MB가 넘으면 서버가 거부해 매 실행마다 실패를 반복하던 문제를 해결했습니다.
- 마지막 조각이 도착해야 데이터베이스가 완료 표시되므로, 중간에 끊긴 마이그레이션이 완료된 것으로 오인되지 않습니다.
- 마이그레이션 진행 상황을 표시하고, 실패하면 알려줍니다. 레거시 데이터로 계속 사용할 수 있는 동작은 그대로입니다.
- 시작 구간별 소요 시간을 콘솔에 기록합니다.
- 플러그인 저장소를 첫 응답에서 빼고 필요할 때 불러옵니다.
- 이 릴리스는 0.3.1을 기준으로 다시 쌓았습니다. 0.3.2.x 계열은 사용하지 않습니다.

## 포함된 RisuBard 변경사항
- RisuBard 0.9.2와 0.9.4의 변경사항을 반영했습니다.
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
