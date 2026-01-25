# Cloud Code
## 로그 내보내기
Add custom logging statements to your Cloud Code scripts and modules to record debugging information.

### Cloud Code JavaScript 스크립트
스크립트 컨텍스트의 일부로 자동 제공되는 기본 로거를 사용하여 Cloud Code JavaScript 스크립트에서 로그를 내보낼 수 있습니다.
다음 코드 샘플은 JavaScript 스크립트를 설정하는 데 필요한 모든 사항을 보여 줍니다.
#### JavaScript
```
module.exports = async ({ params, context, logger }) => {
    logger.info("script executing", {"example.someString": "frog blast the vent core!"});
    logger.warning("this is a serious warning that the cheese is about to run out.");
    logger.error("out of cheese :(", {"example.foo": 42}, {"example.bar": 7});
};
```
이 로거는 다음과 같은 메서드를 제공합니다.
- debug(message, ...logAttributes)
- info(message, ...logAttributes)
- warning(message, ...logAttributes)
- error(message, ...logAttributes)
- fatal(message, ...logAttributes)

#### 제한 사항
호출별로 여러 개의 로그 속성을 전달할 수 있지만, 다음과 같은 제한 사항이 적용됩니다.
- 각 로그 속성은 단일 키/값 페어가 있는 오브젝트여야 합니다.
- 값은 비어 있지 않은 기본 값이어야 합니다(false 부울은 허용됨).